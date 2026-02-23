const express = require('express');
const axios = require('axios');
const yahooFinance = require('yahoo-finance2').default; // v3 최신 방식
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// 주요 종목 티커 사전 (검색 실패 대비)
const STOCKS = {
    '삼성전자': '005930.KS',
    '삼성전자우': '005935.KS',
    'SK하이닉스': '000660.KS',
    '카카오': '035720.KS',
    '네이버': '035420.KS',
    '현대차': '005380.KS',
    '애플': 'AAPL',
    '테슬라': 'TSLA',
    '엔비디아': 'NVDA'
};

app.post('/stock', async (req, res) => {
    try {
        const utterance = req.body.userRequest.utterance || "";
        // 종목명 추출 (주식: 삼성전자 -> 삼성전자)
        const name = utterance.replace(/주식/g, '').replace(/[:：=]/g, '').trim();

        if (!name) {
            return res.json({
                version: "2.0",
                template: { outputs: [{ simpleText: { text: "조회할 종목명을 알려주세요. (예: 주식:삼성전자)" } }] }
            });
        }

        // 1. 티커 결정
        let ticker = STOCKS[name];
        if (!ticker) {
            const search = await yahooFinance.search(name).catch(() => null);
            if (search && search.quotes && search.quotes.length > 0) {
                ticker = search.quotes[0].symbol;
            } else {
                ticker = name + ".KS"; 
            }
        }

        // 2. 주가 데이터 조회
        const quote = await yahooFinance.quote(ticker).catch((err) => {
            console.error("Quote Error:", err);
            return null;
        });

        if (!quote || quote.regularMarketPrice === undefined) {
            return res.json({
                version: "2.0",
                template: { 
                    outputs: [{ 
                        simpleText: { 
                            text: `[${name}] 시세 정보를 가져오지 못했습니다.\n티커: ${ticker}\n\n※ 종목명이 정확한지 확인하시거나 잠시 후 다시 시도해주세요.` 
                        } 
                    }] 
                }
            });
        }

        // 3. 뉴스 분석 (Gemini)
        let analysisText = "";
        try {
            const newsUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(name)}+주식&hl=ko&gl=KR&ceid=KR:ko`;
            const newsResponse = await axios.get(newsUrl);
            const titles = Array.from(newsResponse.data.matchAll(/<title>([^<]+)<\/title>/g))
                                .map(m => m[1])
                                .slice(1, 6);

            if (titles.length > 0) {
                const prompt = `${name} 주식 관련 최신 뉴스들입니다. 호재와 악재를 분류하고 핵심을 요약해주세요.\n\n뉴스 목록:\n${titles.join('\n')}`;
                const result = await model.generateContent(prompt);
                analysisText = result.response.text();
            } else {
                analysisText = "최근 관련 뉴스를 찾을 수 없습니다.";
            }
        } catch (e) {
            analysisText = "뉴스 분석 중 오류가 발생했습니다.";
        }

        // 4. 응답 전송
        const changeSign = quote.regularMarketChange > 0 ? "▲" : (quote.regularMarketChange < 0 ? "▼" : "-");
        const infoLine = `📈 ${quote.shortName || name} (${ticker})\n현재가: ${quote.regularMarketPrice.toLocaleString()} ${quote.currency}\n변동: ${changeSign}${Math.abs(quote.regularMarketChange).toFixed(2)} (${quote.regularMarketChangePercent.toFixed(2)}%)`;

        res.json({
            version: "2.0",
            template: {
                outputs: [{ simpleText: { text: `${infoLine}\n\n${analysisText}` } }]
            }
        });

    } catch (err) {
        res.json({
            version: "2.0",
            template: { outputs: [{ simpleText: { text: "데이터 조회 중 오류가 발생했습니다." } }] }
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started`));

const express = require('express');
const axios = require('axios');
const yahooFinance = require('yahoo-finance2').default;
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// 검색 실패 시 대비 사전
const COMMON_STOCKS = {
    '삼성전자': '005930.KS',
    '하이스닉스': '000660.KS',
    'SK하이닉스': '000660.KS',
    '카카오': '035720.KS',
    '네이버': '035420.KS',
    '현대차': '005380.KS',
    '애플': 'AAPL',
    '테슬라': 'TSLA'
};

app.post('/stock', async (req, res) => {
    try {
        const utterance = req.body.userRequest.utterance || "";
        const stockName = utterance.replace(/주식/g, '').replace(/[:：=]/g, '').trim();

        if (!stockName) {
            return res.json({ version: "2.0", template: { outputs: [{ simpleText: { text: "종목명을 말씀해주세요." } }] } });
        }

        // 1. 티커 결정
        let ticker = COMMON_STOCKS[stockName];
        if (!ticker) {
            const searchRes = await yahooFinance.search(stockName);
            if (searchRes.quotes && searchRes.quotes.length > 0) {
                ticker = searchRes.quotes[0].symbol;
            } else {
                ticker = stockName + ".KS"; // 한국 주식 기본값 시도
            }
        }

        // 2. 시세 및 분석 (동시 실행)
        const [info, newsRes] = await Promise.all([
            yahooFinance.quote(ticker).catch(() => null),
            axios.get(`https://news.google.com/rss/search?q=${encodeURIComponent(stockName)}+주식&hl=ko&gl=KR&ceid=KR:ko`).catch(() => null)
        ]);

        if (!info) throw new Error(`${stockName} 시세를 찾을 수 없습니다.`);

        // 3. 뉴스 요약 (Gemini)
        let analysis = "뉴스 분석 정보를 가져올 수 없습니다.";
        if (newsRes && newsRes.data) {
            const newsTitles = Array.from(newsRes.data.matchAll(/<title>([^<]+)<\/title>/g)).map(m=>m[1]).slice(1, 6);
            const prompt = `${stockName} 관련 뉴스 제목입니다. 호재/악재로 요약해줘: ${newsTitles.join(', ')}`;
            const result = await model.generateContent(prompt);
            analysis = result.response.text();
        }

        const text = `📈 ${info.shortName || info.symbol}\n현재가: ${info.regularMarketPrice.toLocaleString()} ${info.currency}\n변동: ${info.regularMarketChange > 0 ? '▲' : '▼'}${Math.abs(info.regularMarketChange).toFixed(2)} (${info.regularMarketChangePercent.toFixed(2)}%)\n\n${analysis}`;

        res.json({ version: "2.0", template: { outputs: [{ simpleText: { text: text } }] } });

    } catch (e) {
        console.error(e);
        res.json({ version: "2.0", template: { outputs: [{ simpleText: { text: `오류: ${e.message}` } }] } });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running` ));

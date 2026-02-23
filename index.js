const express = require('express');
const axios = require('axios');
const yahooFinance = require('yahoo-finance2').default; // 다시 v2 방식으로 복구
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// 자주 쓰이는 종목을 미리 상수로 등록 (검색 오류 방지)
const COMMON_STOCKS = {
    '삼성전자': '005930.KS',
    '현대차': '005380.KS',
    '카카오': '035720.KS',
    '애플': 'AAPL',
    '테슬라': 'TSLA'
};

app.post('/stock', async (req, res) => {
    try {
        const utterance = req.body.userRequest.utterance || "";
        const stockName = utterance.replace(/주식/g, '').replace(/[:：=]/g, '').trim();

        if (!stockName) {
            return res.json({ version: "2.0", template: { outputs: [{ simpleText: { text: "종목명을 입력해주세요." } }] } });
        }

        // 1. 티커 찾기
        let ticker = COMMON_STOCKS[stockName];
        if (!ticker) {
            try {
                const searchRes = await yahooFinance.search(stockName);
                ticker = (searchRes.quotes && searchRes.quotes.length > 0) ? searchRes.quotes[0].symbol : stockName + ".KS";
            } catch (e) {
                ticker = stockName + ".KS";
            }
        }

        // 2. 주가 및 뉴스 가져오기
        const [info, newsRes] = await Promise.all([
            yahooFinance.quote(ticker).catch(() => null),
            axios.get(`https://news.google.com/rss/search?q=${encodeURIComponent(stockName)}+주식&hl=ko&gl=KR&ceid=KR:ko`).catch(() => null)
        ]);

        if (!info || !info.regularMarketPrice) {
            return res.json({ version: "2.0", template: { outputs: [{ simpleText: { text: `[${stockName}] 시세 정보를 가져올 수 없습니다.` } }] } });
        }

        // 3. Gemini 뉴스 분석
        let analysis = "뉴스 요약 정보를 생성하지 못했습니다.";
        try {
            if (newsRes && newsRes.data) {
                const titles = Array.from(newsRes.data.matchAll(/<title>([^<]+)<\/title>/g)).map(m=>m[1]).slice(1, 6);
                if (titles.length > 0) {
                    const result = await model.generateContent(`${stockName} 주식 최신 뉴스 제목입니다. 호재/악재 분류 및 요약해줘: ${titles.join(', ')}`);
                    analysis = result.response.text();
                }
            }
        } catch (newsErr) { console.log(newsErr); }

        const text = `📈 ${info.shortName || info.symbol}\n현재가: ${info.regularMarketPrice.toLocaleString()} ${info.currency}\n변동: ${info.regularMarketChange > 0 ? '▲' : '▼'}${Math.abs(info.regularMarketChange).toFixed(2)} (${info.regularMarketChangePercent.toFixed(2)}%)\n\n${analysis}`;

        res.json({
            version: "2.0",
            template: { outputs: [{ simpleText: { text: text } }] }
        });

    } catch (e) {
        console.error(e);
        res.json({ version: "2.0", template: { outputs: [{ simpleText: { text: "오류가 발생했습니다. 나중에 다시 시도해주세요." } }] } });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Bot is running'));

const express = require('express');
const axios = require('axios');
const { YahooFinance } = require('yahoo-finance2'); // 이 부분이 바뀌었습니다
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
app.use(express.json());

// 야후 파이낸스 초기화
const yahooFinance = new YahooFinance(); 

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const COMMON_STOCKS = {
    '삼성전자': '005930.KS',
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

        // 1. 티커 찾기
        let ticker = COMMON_STOCKS[stockName];
        if (!ticker) {
            const searchRes = await yahooFinance.search(stockName);
            if (searchRes.quotes && searchRes.quotes.length > 0) {
                ticker = searchRes.quotes[0].symbol;
            } else {
                ticker = stockName + ".KS";
            }
        }

        // 2. 데이터 가져오기 (quote 메서드 사용법 확인)
        const [info, newsRes] = await Promise.all([
            yahooFinance.quote(ticker).catch(() => null),
            axios.get(`https://news.google.com/rss/search?q=${encodeURIComponent(stockName)}+주식&hl=ko&gl=KR&ceid=KR:ko`).catch(() => null)
        ]);

        if (!info || !info.regularMarketPrice) {
            throw new Error(`[${ticker}] 시세를 찾을 수 없습니다.`);
        }

        // 3. 뉴스 분석
        let analysis = "뉴스 요약 정보를 생성할 수 없습니다.";
        if (newsRes && newsRes.data) {
            const newsTitles = Array.from(newsRes.data.matchAll(/<title>([^<]+)<\/title>/g)).map(m=>m[1]).slice(1, 6);
            if (newsTitles.length > 0) {
                const prompt = `${stockName} 주식 최신 뉴스 제목입니다. 호재/악재 분류 및 요약해줘: ${newsTitles.join(', ')}`;
                const result = await model.generateContent(prompt);
                analysis = result.response.text();
            }
        }

        const text = `📈 ${info.shortName || info.symbol}\n현재가: ${info.regularMarketPrice.toLocaleString()} ${info.currency}\n변동: ${info.regularMarketChange > 0 ? '▲' : '▼'}${Math.abs(info.regularMarketChange).toFixed(2)} (${info.regularMarketChangePercent.toFixed(2)}%)\n\n${analysis}`;

        res.json({ version: "2.0", template: { outputs: [{ simpleText: { text: text } }] } });

    } catch (e) {
        res.json({ version: "2.0", template: { outputs: [{ simpleText: { text: `오류: ${e.message}` } }] } });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Bot is live!'));

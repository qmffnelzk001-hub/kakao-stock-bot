const express = require('express');
const axios = require('axios');
const YahooFinance = require('yahoo-finance2').default; // 최신 버전 방식
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
app.use(express.json());

// 야후 파이낸스 인스턴스 생성
const yahooFinance = new YahooFinance();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const STOCKS = { '삼성전자': '005930.KS', 'SK하이닉스': '000660.KS', '애플': 'AAPL', '테슬라': 'TSLA', '현대차': '005380.KS' };

app.post('/stock', async (req, res) => {
    try {
        const msg = req.body.userRequest.utterance || "";
        const name = msg.replace(/주식/g, '').replace(/[:：=]/g, '').trim();
        
        if (!name) return res.json({ version: "2.0", template: { outputs: [{ simpleText: { text: "종목명을 알려주세요." } }] } });

        // 1. 티커 결정
        let ticker = STOCKS[name];
        if (!ticker) {
            const search = await yahooFinance.search(name).catch(() => null);
            ticker = (search && search.quotes && search.quotes[0]) ? search.quotes[0].symbol : name + ".KS";
        }

        // 2. 주가 정보 가져오기
        const info = await yahooFinance.quote(ticker).catch((err) => {
            console.error("Quote Error:", err);
            return null;
        });

        if (!info || !info.regularMarketPrice) {
            return res.json({ version: "2.0", template: { outputs: [{ simpleText: { text: `[${name}] 시세 정보를 찾을 수 없습니다.` } }] } });
        }

        // 3. 뉴스 및 AI 분석
        let analysis = "";
        try {
            const news = await axios.get(`https://news.google.com/rss/search?q=${encodeURIComponent(name)}+주식&hl=ko&gl=KR&ceid=KR:ko`);
            const titles = Array.from(news.data.matchAll(/<title>([^<]+)<\/title>/g)).map(m=>m[1]).slice(1, 5);
            const aiRes = await model.generateContent(`${name} 주식 뉴스 분석해줘: ${titles.join(', ')}`);
            analysis = aiRes.response.text();
        } catch (e) { analysis = "뉴스를 분석하지 못했습니다."; }

        const responseMsg = `📈 ${info.shortName || name}\n현재가: ${info.regularMarketPrice.toLocaleString()} ${info.currency}\n변동: ${info.regularMarketChange > 0 ? '▲' : '▼'}${Math.abs(info.regularMarketChange).toFixed(2)}\n\n${analysis}`;

        res.json({ version: "2.0", template: { outputs: [{ simpleText: { text: responseMsg } }] } });

    } catch (e) {
        // 실제 에러 내용을 봇이 응답하게 하여 디버깅을 돕습니다.
        res.json({ version: "2.0", template: { outputs: [{ simpleText: { text: `에러 발생: ${e.message.substring(0, 50)}` } }] } });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server is running'));

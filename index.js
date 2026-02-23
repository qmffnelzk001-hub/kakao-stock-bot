const express = require('express');
const axios = require('axios');
const yahooFinance = require('yahoo-finance2').default;
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// 자주 쓰이는 한글 종목 매핑 (검색 실패 방지용)
const COMMON_STOCKS = {
    '삼성전자': '005930.KS',
    '삼성전자우': '005935.KS',
    'SK하이닉스': '000660.KS',
    'LG에너지솔루션': '373220.KS',
    '현대차': '005380.KS',
    '기아': '000270.KS',
    '네이버': '035420.KS',
    'NAVER': '035420.KS',
    '카카오': '035720.KS',
    '삼성바이오로직스': '207940.KS',
    '애플': 'AAPL',
    '테슬라': 'TSLA',
    '엔비디아': 'NVDA'
};

async function findTickerWithAI(name) {
    const prompt = `주식 종목 '${name}'의 Yahoo Finance 티커 심볼만 알려줘. 
    마크다운이나 설명 없이 딱 코드만 한 줄로 보내. 예: 삼성전자는 005930.KS, 애플은 AAPL.`;
    
    try {
        const result = await model.generateContent(prompt);
        let text = result.response.text().trim();
        // 불필요한 마크다운이나 따옴표 제거
        text = text.replace(/```[a-z]*\n?/g, '').replace(/```/g, '').replace(/['"`]/g, '').trim();
        return text;
    } catch (e) {
        return null;
    }
}

async function findTicker(name) {
    // 1. 사전 등록된 종목 우선 확인
    if (COMMON_STOCKS[name]) return COMMON_STOCKS[name];

    try {
        // 2. 야후 자체 검색
        let results = await yahooFinance.search(name);
        if (results.quotes && results.quotes.length > 0) {
            const equity = results.quotes.find(q => q.quoteType === 'EQUITY');
            if (equity) return equity.symbol;
            return results.quotes[0].symbol;
        }

        // 3. AI 기반 검색 시도
        const aiTicker = await findTickerWithAI(name);
        if (aiTicker && aiTicker.length >= 2 && !aiTicker.includes(' ')) return aiTicker;
    } catch (e) { console.error('검색 오류:', e); }
    return null;
}

async function getStockPrice(ticker) {
    try {
        const quote = await yahooFinance.quote(ticker);
        if (!quote) return null;
        return {
            price: quote.regularMarketPrice,
            change: quote.regularMarketChange,
            changePercent: quote.regularMarketChangePercent,
            currency: quote.currency,
            name: quote.shortName || quote.longName || ticker
        };
    } catch (e) { return null; }
}

async function getAnalyzedNews(name) {
    try {
        const rssUrl = `[https://news.google.com/rss/search?q=${encodeURIComponent(name)}+주식&hl=ko&gl=KR&ceid=KR:ko`](https://news.google.com/rss/search?q=${encodeURIComponent(name)}+주식&hl=ko&gl=KR&ceid=KR:ko`);
        const response = await axios.get(rssUrl);
        const xml = response.data;
        const matches = Array.from(xml.matchAll(/<title>([^<]+)<\/title>/g)).map(m=>m[1]).slice(1, 11);
        const links = Array.from(xml.matchAll(/<link>([^<]+)<\/link>/g)).map(m=>m[1]).slice(1, 11);

        if (matches.length === 0) return "관련 뉴스를 찾지 못했습니다.";

        const prompt = `${name} 종목 최신 뉴스들입니다. 호재와 악재를 분류해 요약해줘: ${matches.slice(0, 5).join('\n')}`;
        const result = await model.generateContent(prompt);
        let final = result.response.text().trim() + "\n\n🔗 관련 뉴스:\n";
        for(let i=0; i<Math.min(3, matches.length); i++) {
            final += `- ${matches[i]}\n  ${links[i]}\n`;
        }
        return final;
    } catch (e) { return "뉴스 분석 중 오류가 발생했습니다."; }
}

app.post('/stock', async (req, res) => {
    const utterance = req.body.userRequest.utterance || "";
    const stockName = utterance.replace(/주식/g, '').replace(/[:：=]/g, '').trim();

    if (!stockName) {
        return res.json({ version: "2.0", template: { outputs: [{ simpleText: { text: "종목명을 입력하세요! (예: 삼성전자)" } }] } });
    }

    try {
        const ticker = await findTicker(stockName);
        if (!ticker) throw new Error(`[${stockName}] 종목을 찾을 수 없습니다.`);

        const [info, analysis] = await Promise.all([getStockPrice(ticker), getAnalyzedNews(stockName)]);
        if (!info) throw new Error(`[${ticker}] 시세를 가져올 수 없습니다.`);

        const text = `📈 ${info.name} (${ticker})\n현재가: ${info.price.toLocaleString()} ${info.currency}\n변동: ${info.change > 0 ? '▲' : '▼'}${Math.abs(info.change).toLocaleString()} (${info.changePercent.toFixed(2)}%)\n\n${analysis}`;

        res.json({ version: "2.0", template: { outputs: [{ simpleText: { text } }] } });
    } catch (

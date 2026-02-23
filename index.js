const express = require('express');
const axios = require('axios');
const yahooFinance = require('yahoo-finance2').default;
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// AI를 사용하여 티커(종목코드)를 찾는 보조 함수
async function findTickerWithAI(name) {
    const prompt = `주식 종목 '${name}'의 Yahoo Finance 티커 심볼(Ticker Symbol)만 알려줘. 
    한국 주식이면 '005930.KS' 같이 숫자 뒤에 .KS나 .KQ를 붙여주고, 미국 주식이면 'AAPL' 같이 대문자로 알려줘. 
    다른 설명은 절대 하지 말고 딱 티커 코드만 한 줄로 보내줘.`;
    
    try {
        const result = await model.generateContent(prompt);
        return result.response.text().trim().replace(/['"`]/g, '');
    } catch (e) {
        return null;
    }
}

async function findTicker(name) {
    try {
        // 1. 야후 자체 검색 시도
        let results = await yahooFinance.search(name);
        if (results.quotes && results.quotes.length > 0) {
            const topMatch = results.quotes.find(q => q.shortname || q.longname);
            if (topMatch) return topMatch.symbol;
        }

        // 2. 검색 실패 시 AI에게 티커 코드 물어보기 (매우 강력함)
        const aiTicker = await findTickerWithAI(name);
        if (aiTicker && aiTicker.length > 1) return aiTicker;
    } catch (e) { console.error(e); }
    return null;
}

async function getStockPrice(ticker) {
    try {
        const quote = await yahooFinance.quote(ticker);
        if (!quote || !quote.regularMarketPrice) return null;
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
        const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(name)}+주식&hl=ko&gl=KR&ceid=KR:ko`;
        const response = await axios.get(rssUrl);
        const xml = response.data;
        const matches = Array.from(xml.matchAll(/<title>([^<]+)<\/title>/g)).map(m=>m[1]).slice(1, 6);
        const links = Array.from(xml.matchAll(/<link>([^<]+)<\/link>/g)).map(m=>m[1]).slice(1, 6);

        if (matches.length === 0) return "최신 뉴스를 찾을 수 없습니다.";

        const prompt = `${name} 주식 최신 뉴스 제목들입니다. 호재와 악재로 분석해 요약해줘: ${matches.join(', ')}`;
        const result = await model.generateContent(prompt);
        let final = result.response.text().trim() + "\n\n🔗 관련 뉴스:\n";
        for(let i=0; i<Math.min(3, matches.length); i++) {
            final += `- ${matches[i]}\n  ${links[i]}\n`;
        }
        return final;
    } catch (e) { return "뉴스 분석 정보를 불러올 수 없습니다."; }
}

app.post('/stock', async (req, res) => {
    const utterance = req.body.userRequest.utterance || "";
    const stockName = utterance.replace(/주식/g, '').replace(/[:：=]/g, '').trim();

    if (!stockName) {
        return res.json({ version: "2.0", template: { outputs: [{ simpleText: { text: "종목명을 입력해주세요! (예: 삼성전자)" } }] } });
    }

    try {
        const ticker = await findTicker(stockName);
        if (!ticker) throw new Error(`[${stockName}] 종목의 티커 코드를 찾을 수 없습니다.`);

        const info = await getStockPrice(ticker);
        if (!info) throw new Error(`[${ticker}] 종목 상세 정보를 가져올 수 없습니다.`);

        const analysis = await getAnalyzedNews(stockName);
        const text = `📈 ${info.name} (${ticker})\n현재가: ${info.price.toLocaleString()} ${info.currency}\n변동: ${info.change > 0 ? '▲' : '▼'}${Math.abs(info.change).toLocaleString()} (${info.changePercent.toFixed(2)}%)\n\n${analysis}`;

        res.json({ version: "2.0", template: { outputs: [{ simpleText: { text } }] } });
    } catch (error) {
        res.json({ version: "2.0", template: { outputs: [{ simpleText: { text: `오류: ${error.message}` } }] } });
    }
});

app.listen(process.env.PORT || 3000);

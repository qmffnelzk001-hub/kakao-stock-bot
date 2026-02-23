const express = require('express');
const axios = require('axios');
const yahooFinance = require('yahoo-finance2').default;
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// 티커 검색 (더 똑똑하게 종목명을 찾습니다)
async function findTicker(name) {
    console.log(`검색 요청 종목명: ${name}`); // Render 로그에서 확인 가능
    try {
        // 1. 단순 이름으로 검색
        let results = await yahooFinance.search(name);
        if (results.quotes && results.quotes.length > 0) return results.quotes[0].symbol;

        // 2. 한국 주식 (코스피) 시도
        results = await yahooFinance.search(name + ".KS");
        if (results.quotes && results.quotes.length > 0) return results.quotes[0].symbol;

        // 3. 한국 주식 (코스닥) 시도
        results = await yahooFinance.search(name + ".KQ");
        if (results.quotes && results.quotes.length > 0) return results.quotes[0].symbol;
    } catch (e) { console.error(e); }
    return null;
}

async function getStockPrice(ticker) {
    try {
        const quote = await yahooFinance.quote(ticker);
        return {
            price: quote.regularMarketPrice,
            change: quote.regularMarketChange,
            changePercent: quote.regularMarketChangePercent,
            currency: quote.currency,
            name: quote.shortName || ticker
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

        const prompt = `${name} 주식 최신 뉴스 제목들입니다. 호재와 악재로 분석해 요약해줘: ${matches.join(', ')}`;
        const result = await model.generateContent(prompt);
        let final = result.response.text() + "\n\n🔗 관련 뉴스:\n";
        for(let i=0; i<3; i++) if(matches[i]) final += `- ${matches[i]}\n  ${links[i]}\n`;
        return final;
    } catch (e) { return "뉴스 분석 실패"; }
}

app.post('/stock', async (req, res) => {
    const utterance = req.body.userRequest.utterance || "";
    // 어떤 입력(주식:삼성전자, 삼성전자 주식 등)에도 이름만 쏙 뽑아내는 필터
    const stockName = utterance.replace(/주식/g, '').replace(/[:：=]/g, '').trim();

    if (!stockName) {
        return res.json({ version: "2.0", template: { outputs: [{ simpleText: { text: "종목명을 입력해주세요!" } }] } });
    }

    try {
        const ticker = await findTicker(stockName);
        if (!ticker) throw new Error(`[${stockName}] 종목을 찾을 수 없습니다.`);

        const [info, analysis] = await Promise.all([getStockPrice(ticker), getAnalyzedNews(stockName)]);
        const text = `📈 ${info.name}\n현재가: ${info.price.toLocaleString()} ${info.currency}\n변동: ${info.change > 0 ? '▲' : '▼'}${Math.abs(info.change).toFixed(2)} (${info.changePercent.toFixed(2)}%)\n\n${analysis}`;

        res.json({ version: "2.0", template: { outputs: [{ simpleText: { text } }] } });
    } catch (error) {
        res.json({ version: "2.0", template: { outputs: [{ simpleText: { text: `오류: ${error.message}` } }] } });
    }
});

app.listen(process.env.PORT || 3000);

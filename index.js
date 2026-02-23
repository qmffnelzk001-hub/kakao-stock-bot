const express = require('express');
const axios = require('axios');
const yahooFinance = require('yahoo-finance2').default;
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// 티커 검색 기능 강화
async function findTicker(name) {
    try {
        // 1. 일반 검색 시도
        let results = await yahooFinance.search(name);
        if (results.quotes && results.quotes.length > 0) {
            return results.quotes[0].symbol;
        }

        // 2. 한국 주식 전용 검색 시도 (종목명 뒤에 .KS 붙여서 재시도)
        results = await yahooFinance.search(name + ".KS");
        if (results.quotes && results.quotes.length > 0) {
            return results.quotes[0].symbol;
        }
    } catch (error) {
        console.error('Ticker 검색 오류:', error);
    }
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
    } catch (error) {
        console.error('주가 조회 오류:', error);
        return null;
    }
}

async function getAnalyzedNews(name) {
    try {
        const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(name)}+주식&hl=ko&gl=KR&ceid=KR:ko`;
        const response = await axios.get(rssUrl);
        const xml = response.data;
        
        const titles = [];
        const links = [];
        const titleMatches = Array.from(xml.matchAll(/<title>([^<]+)<\/title>/g)).map(m => m[1]).slice(1, 11);
        const linkMatches = Array.from(xml.matchAll(/<link>([^<]+)<\/link>/g)).map(m => m[1]).slice(1, 11);

        const prompt = `
            다음은 '${name}' 주식 최신 뉴스 제목입니다. 호재와 악재로 분류하고 아주 짧게 요약해줘.
            📢 [호재 뉴스], ⚠️ [악재 뉴스] 형식으로 작성해줘.
            뉴스 리스트:
            ${titleMatches.join('\n')}
        `;

        const result = await model.generateContent(prompt);
        const analysisText = result.response.text();

        let finalResponse = analysisText + "\n\n🔗 관련 뉴스:\n";
        for (let i = 0; i < Math.min(3, titleMatches.length); i++) {
            finalResponse += `- ${titleMatches[i]}\n  ${linkMatches[i]}\n`;
        }
        return finalResponse;
    } catch (error) {
        return "뉴스를 가져오는 중에 문제가 발생했습니다.";
    }
}

app.post('/stock', async (req, res) => {
    let utterance = req.body.userRequest.utterance || "";
    // 종목명 추출 로직 개선 (주식, 삼성전자, 주식:삼성전자 모두 대응)
    let stockName = utterance.replace('주식', '').replace(':', '').replace('=', '').trim();

    if (!stockName) {
        return res.json({
            version: "2.0",
            template: { outputs: [{ simpleText: { text: "분석할 종목명을 입력해주세요. (예: 주식 : 삼성전자)" } }] }
        });
    }

    try {
        const ticker = await findTicker(stockName);
        if (!ticker) throw new Error(`${stockName} 종목을 찾을 수 없습니다.`);

        const info = await getStockPrice(ticker);
        const analysis = await getAnalyzedNews(stockName);

        const priceText = `📈 ${info.name}\n현재가: ${info.price.toLocaleString()} ${info.currency}\n변동: ${info.change > 0 ? '▲' : '▼'} ${info.change.toFixed(2)} (${info.changePercent.toFixed(2)}%)`;

        res.json({
            version: "2.0",
            template: { outputs: [{ simpleText: { text: `${priceText}\n\n${analysis}` } }] }
        });
    } catch (error) {
        res.json({
            version: "2.0",
            template: { outputs: [{ simpleText: { text: `오류: ${error.message}` } }] }
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running on ${PORT}`));

const express = require('express');
const axios = require('axios');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// 자주 검색되는 종목 매핑 (속도와 정확도를 위해)
const COMMON_STOCKS = {
    '삼성전자': '005930.KS',
    '애플': 'AAPL',
    '테슬라': 'TSLA',
    '엔비디아': 'NVDA',
    '네이버': '035420.KS',
    '카카오': '035720.KS',
    'sk하이닉스': '006660.KS',
    '하이닉스': '006660.KS',
    '현대차': '005380.KS',
    '기아': '000270.KS',
    '에코프로': '086520.KQ',
    '삼성sdi': '006400.KS'
};

/**
 * 뉴스 제목에서 6자리 종목 코드를 추출하여 티커로 변환 (한국 주식용)
 */
async function extractTickerFromNews(name) {
    try {
        const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(name)}+주식&hl=ko&gl=KR&ceid=KR:ko`;
        const response = await axios.get(rssUrl, { timeout: 3000 });
        const xml = response.data;
        
        const match = xml.match(/\((\d{6})\)/);
        if (match) {
            const code = match[1];
            return `${code}.KS`; 
        }
    } catch (e) {
        console.error(`[TickerExtract] Error: ${e.message}`);
    }
    return null;
}

async function findTicker(input) {
    const cleanInput = input.trim().toLowerCase();
    const cleanInputUpper = cleanInput.toUpperCase();
    
    if (/^\d{6}$/.test(cleanInput)) return `${cleanInputUpper}.KS`;
    if (cleanInputUpper.includes('.') && /^[0-9A-Z.]+$/.test(cleanInputUpper)) return cleanInputUpper;

    const mapped = COMMON_STOCKS[cleanInput];
    if (mapped) return mapped;

    const extracted = await extractTickerFromNews(input);
    if (extracted) return extracted;

    try {
        const results = await yahooFinance.search(input);
        if (results.quotes && results.quotes.length > 0) return results.quotes[0].symbol;
    } catch (error) {
        console.warn(`[TickerSearch] Failed:`, error.message);
    }
    return null;
}

async function getStockPrice(ticker) {
    try {
        const quote = await yahooFinance.quote(ticker);
        if (!quote || quote.regularMarketPrice === undefined) {
            if (ticker.endsWith('.KS')) return await getStockPrice(ticker.replace('.KS', '.KQ'));
            return null;
        }
        return {
            price: quote.regularMarketPrice,
            change: quote.regularMarketChange,
            changePercent: quote.regularMarketChangePercent,
            currency: quote.currency,
            name: quote.shortName || quote.longName || ticker
        };
    } catch (error) {
        if (ticker.endsWith('.KS')) return await getStockPrice(ticker.replace('.KS', '.KQ'));
        return null;
    }
}

/**
 * 뉴스 분석 (긍정/부정 요약 + 투자 비율)
 */
async function getAnalyzedNews(name) {
    const analysisPromise = (async () => {
        try {
            const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(name)}+주식&hl=ko&gl=KR&ceid=KR:ko`;
            const response = await axios.get(rssUrl, { timeout: 3000 });
            const xml = response.data;
            
            // 실제 기사 제목들 추출 (Google 뉴스 기본 정보 건너뜀)
            const titles = Array.from(xml.matchAll(/<title>([^<]+)<\/title>/g)).map(m => m[1]).slice(2, 6);
            if (titles.length === 0) return "분석할 최신 뉴스가 없습니다.";

            // 사용자 요청에 맞춘 필살 프롬프트
            const prompt = `
                주식 '${name}' 관련 뉴스 제목들입니다:
                ${titles.join('\n')}

                위 내용을 종합해서 다음 형식을 지켜 딱 3줄로 요약해줘 (한국어):
                1. 📢 긍정: [호재 내용을 1줄로 요약]
                2. ⚠️ 부정: [악재 내용을 1줄로 요약]
                3. 📊 투자 의견: 매수 [00]%, 매도 [00]%, 보류 [00]%
                
                (비율의 합은 100%가 되어야 함. 분석이 어려우면 보류 비율을 높여줘.)
            `;
            
            try {
                const result = await model.generateContent(prompt);
                return result.response.text().trim();
            } catch (apiError) {
                console.error("[Gemini Error]:", apiError.message);
                return "AI 분석 일시 제한 (API 키 상태를 확인해주세요.)\n\n최신 뉴스:\n- " + titles.slice(0, 2).join('\n- ');
            }
        } catch (e) {
            return "현재 뉴스 분석 서비스가 원활하지 않습니다.";
        }
    })();

    const timeoutPromise = new Promise((resolve) => 
        setTimeout(() => resolve("분석 중... (주가 먼저 확인하세요)"), 3800)
    );

    return Promise.race([analysisPromise, timeoutPromise]);
}

app.post('/stock', async (req, res) => {
    try {
        const utterance = req.body.userRequest?.utterance;
        if (!utterance) throw new Error('Empty');

        let stockName = utterance.replace(/^주식\s*[:：]?\s*/, '').trim();
        const ticker = await findTicker(stockName);
        if (!ticker) {
            return res.json({ version: "2.0", template: { outputs: [{ simpleText: { text: `'${stockName}' 종목을 찾을 수 없습니다.` } }] } });
        }

        const [info, analysis] = await Promise.all([
            getStockPrice(ticker),
            getAnalyzedNews(stockName)
        ]);

        if (!info) {
            return res.json({ version: "2.0", template: { outputs: [{ simpleText: { text: `'${ticker}' 주가 조회 실패.` } }] } });
        }

        const priceText = `📈 ${info.name} (${ticker})\n현재가: ${info.price.toLocaleString()} ${info.currency}\n변동: ${info.change > 0 ? '▲' : '▼'} ${Math.abs(info.change).toLocaleString()} (${info.changePercent?.toFixed(2)}%)`;

        res.json({
            version: "2.0",
            template: { outputs: [{ simpleText: { text: `${priceText}\n\n${analysis}` } }] }
        });
    } catch (error) {
        res.json({ version: "2.0", template: { outputs: [{ simpleText: { text: "일시적 오류입니다." } }] } });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));

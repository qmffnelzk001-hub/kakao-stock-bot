const express = require('express');
const axios = require('axios');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// 모델명을 더 호환성이 높은 gemini-pro로 변경 시도
const model = genAI.getGenerativeModel({ model: "gemini-pro" });

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

        // 뉴스 제목이나 설명에서 (005930) 같은 숫자 패턴 찾기
        const match = xml.match(/\((\d{6})\)/);
        if (match) {
            const code = match[1];
            console.log(`[TickerExtract] Found code ${code} from news for ${name}`);
            return `${code}.KS`;
        }
    } catch (e) {
        console.error(`[TickerExtract] Error: ${e.message}`);
    }
    return null;
}

/**
 * 주식 종목명으로 티커(Ticker) 검색
 */
async function findTicker(input) {
    const cleanInput = input.trim().toLowerCase();
    const cleanInputUpper = cleanInput.toUpperCase();
    console.log(`[TickerCheck] Input: "${input}"`);

    // 1. 한국 주식 코드(6자리 숫자)인 경우 직접 변환
    if (/^\d{6}$/.test(cleanInput)) {
        return `${cleanInputUpper}.KS`;
    }

    // 2. 이미 티커 형식(.KS, .KQ 등 마침표 포함)인 경우 그대로 사용
    if (cleanInputUpper.includes('.') && /^[0-9A-Z.]+$/.test(cleanInputUpper)) {
        return cleanInputUpper;
    }

    // 3. 주요 종목 사전에 정의된 매핑 사용
    const mapped = COMMON_STOCKS[cleanInput];
    if (mapped) {
        console.log(`[TickerCheck] Mapped ${cleanInput} to ${mapped}`);
        return mapped;
    }

    // 4. 뉴스 RSS에서 6자리 코드 추출 시도 (한국 주식 특화)
    const extracted = await extractTickerFromNews(input);
    if (extracted) return extracted;

    // 5. 야후 파이낸스 라이브러리 검색 (최후의 수단)
    try {
        console.log(`[TickerSearch] Searching Yahoo: ${input}`);
        const results = await yahooFinance.search(input);
        if (results.quotes && results.quotes.length > 0) {
            const ticker = results.quotes[0].symbol;
            console.log(`[TickerSearch] Found: ${ticker}`);
            return ticker;
        }
    } catch (error) {
        console.warn(`[TickerSearch] Failed for "${input}":`, error.message);
    }

    return null;
}

/**
 * 실시간 주가 정보 가져오기 (3단계 강력 폴백 적용)
 */
async function getStockPrice(ticker) {
    try {
        console.log(`[StockPrice] Requesting: ${ticker}`);

        // 단계 1: 라이브러리 기본 quote API
        try {
            const quote = await yahooFinance.quote(ticker);
            if (quote && quote.regularMarketPrice !== undefined) {
                console.log(`[StockPrice] 1단계(Quote) 성공: ${ticker} = ${quote.regularMarketPrice}`);
                return {
                    price: quote.regularMarketPrice,
                    change: quote.regularMarketChange,
                    changePercent: quote.regularMarketChangePercent,
                    currency: quote.currency,
                    name: quote.shortName || quote.longName || ticker
                };
            }
        } catch (e1) {
            console.warn(`[StockPrice] 1단계(Quote) 실패 (${ticker}): ${e1.message}`);
        }

        // 단계 2: 라이브러리 chart API
        try {
            const chart = await yahooFinance.chart(ticker, { period1: '1d' });
            if (chart && chart.meta && chart.meta.regularMarketPrice !== undefined) {
                console.log(`[StockPrice] 2단계(Chart) 성공: ${ticker}`);
                return {
                    price: chart.meta.regularMarketPrice,
                    change: chart.meta.regularMarketPrice - chart.meta.previousClose,
                    changePercent: ((chart.meta.regularMarketPrice - chart.meta.previousClose) / chart.meta.previousClose) * 100,
                    currency: chart.meta.currency,
                    name: ticker
                };
            }
        } catch (e2) {
            console.warn(`[StockPrice] 2단계(Chart) 실패 (${ticker}): ${e2.message}`);
        }

        // 단계 3: 직접 HTTP 요청 (Axios + User-Agent) - 라이브러리 차단 대비
        try {
            console.log(`[StockPrice] 3단계(Direct HTTP) 시도: ${ticker}`);
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`;
            const res = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, Gecko) Chrome/120.0.0.0 Safari/537.36'
                },
                timeout: 5000
            });
            const data = res.data?.chart?.result?.[0]?.meta;
            if (data && data.regularMarketPrice !== undefined) {
                console.log(`[StockPrice] 3단계(Direct HTTP) 성공: ${ticker}`);
                return {
                    price: data.regularMarketPrice,
                    change: data.regularMarketPrice - data.previousClose,
                    changePercent: ((data.regularMarketPrice - data.previousClose) / data.previousClose) * 100,
                    currency: data.currency,
                    name: ticker
                };
            }
        } catch (e3) {
            console.error(`[StockPrice] 3단계(Direct HTTP) 실패 (${ticker}): ${e3.message}`);
        }

        // 한국 주식(.KS) 실패 시 .KQ(코스닥)로 자동 전환 시도
        if (ticker.endsWith('.KS')) {
            const kqTicker = ticker.replace('.KS', '.KQ');
            console.log(`[StockPrice] .KS 실패로 .KQ 재시도: ${kqTicker}`);
            return await getStockPrice(kqTicker);
        }

        return null;
    } catch (error) {
        console.error(`[StockPrice Critical Error] ${ticker}:`, error.message);
        return null;
    }
}

/**
 * 뉴스 검색 및 Gemini 분석 (긍정/부정 요약 + 투자 비율)
 */
async function getAnalyzedNews(name) {
    const analysisPromise = (async () => {
        try {
            const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(name)}+주식&hl=ko&gl=KR&ceid=KR:ko`;
            const response = await axios.get(rssUrl, { timeout: 3000 });
            const xml = response.data;

            // 뉴스 제목 및 링크 추출 (첫 2개는 Google 뉴스 기본 정보일 수 있으므로 건너뜀)
            const titles = Array.from(xml.matchAll(/<title>([^<]+)<\/title>/g)).map(m => m[1]).slice(2, 6);
            const links = Array.from(xml.matchAll(/<link>([^<]+)<\/link>/g)).map(m => m[1]).slice(2, 5);

            if (titles.length === 0) return "분석할 최신 뉴스가 없습니다.";

            // 사용자 요청에 맞춘 정교한 프롬프트
            const prompt = `
                다음은 주식 '${name}'의 최신 뉴스 제목들입니다.
                다음 형식을 엄격히 지켜서 딱 3줄로 응답해줘 (한국어):
                1. 긍정적인 내용 요약 (1줄, 📢 긍정: [내용])
                2. 부정적인 내용 요약 (1줄, ⚠️ 부정: [내용])
                3. 뉴스 기반 매수, 매도, 보류 판단 비율 (1줄, 📊 투자 의견: 매수 00%, 매도 00%, 보류 00%)
                
                뉴스 제목:
                ${titles.join('\n')}
            `;

            let analysisText = "";
            try {
                const result = await model.generateContent(prompt);
                const aiRes = await result.response;
                analysisText = aiRes.text().trim();
            } catch (apiError) {
                console.error("[Gemini API Error Detail]:", apiError.message || apiError);
                analysisText = "현재 AI 분석 서비스 연결이 원활하지 않아 뉴스 제목을 우선 전달합니다.";
            }

            let finalResponse = analysisText + "\n\n🔗 관련 링크:\n";
            for (let i = 0; i < Math.min(titles.length, 2); i++) {
                finalResponse += `- ${titles[i]}\n  ${links[i]}\n`;
            }
            return finalResponse;
        } catch (e) {
            console.error(`[News Error]: ${e.message}`);
            return "현재 뉴스 분석 데이터를 가져올 수 없습니다.";
        }
    })();

    // 3.5초 타임아웃 세이프가드 (카카오톡 대응)
    const timeoutPromise = new Promise((resolve) =>
        setTimeout(() => resolve("뉴스 분석 중입니다. 잠시 후 주가와 함께 다시 확인해주세요."), 3500)
    );

    return Promise.race([analysisPromise, timeoutPromise]);
}

app.post('/stock', async (req, res) => {
    try {
        const utterance = req.body.userRequest?.utterance;
        if (!utterance) throw new Error('Empty utterance');

        let stockName = utterance.replace(/^주식\s*[:：]?\s*/, '').trim();
        if (!stockName) {
            return res.json({ version: "2.0", template: { outputs: [{ simpleText: { text: "종목명을 입력해주세요." } }] } });
        }

        console.log(`[Request] stockName: [${stockName}]`);

        // 1. 티커 찾기
        const ticker = await findTicker(stockName);
        if (!ticker) {
            return res.json({
                version: "2.0",
                template: {
                    outputs: [{ simpleText: { text: `'${stockName}' 종목을 찾을 수 없습니다. (예: 005930 또는 삼성전자)` } }]
                }
            });
        }

        // 2. 주가 및 뉴스 병렬 수집
        const [info, analysis] = await Promise.all([
            getStockPrice(ticker),
            getAnalyzedNews(stockName)
        ]);

        if (!info) {
            return res.json({
                version: "2.0",
                template: { outputs: [{ simpleText: { text: `'${ticker}' 정보를 가져오지 못했습니다. 잠시 후 다시 조회를 부탁드립니다.` } }] }
            });
        }

        const priceText = `📈 ${info.name} (${ticker})\n현재가: ${info.price.toLocaleString()} ${info.currency}\n변동: ${info.change > 0 ? '▲' : '▼'} ${Math.abs(info.change).toLocaleString()} (${info.changePercent?.toFixed(2)}%)`;

        res.json({
            version: "2.0",
            template: {
                outputs: [{ simpleText: { text: `${priceText}\n\n${analysis}` } }]
            }
        });

    } catch (error) {
        console.error('[EndpointError]', error.message);
        res.json({
            version: "2.0",
            template: { outputs: [{ simpleText: { text: "일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요." } }] }
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`카카오톡 주식 봇 서버가 포트 ${PORT}에서 실행 중입니다.`);
});

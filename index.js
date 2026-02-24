const express = require('express');
const axios = require('axios');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// 모델명을 최신 표준인 gemini-2.5-flash로 변경 (2026년 기준) 및 안전 설정 완화
const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
    ]
});

// 자주 검색되는 종목 매핑 (속도와 정확도를 위해)
const COMMON_STOCKS = {
    '삼성전자': '005930.KS',
    '애플': 'AAPL',
    '테슬라': 'TSLA',
    '엔비디아': 'NVDA',
    '네이버': '035420.KS',
    'naver': '035420.KS',
    '카카오': '035720.KS',
    'sk하이닉스': '000660.KS',
    '하이닉스': '000660.KS',
    'sk': '003600.KS',
    '현대차': '005380.KS',
    '현대자동차': '005380.KS',
    '기아': '000270.KS',
    '에코프로': '086520.KQ',
    '삼성sdi': '006400.KS',
    'lg에너지솔루션': '373220.KS',
    'lg엔솔': '373220.KS',
    '포스코홀딩스': '005490.KS',
    'posco홀딩스': '005490.KS'
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

// 분석 결과 캐시 (메모리 내 저장)
const ANALYSIS_CACHE = new Map();
const CACHE_TTL = 1000 * 60 * 10; // 10분간 유효

/**
 * 뉴스 검색 및 Gemini 분석
 */
async function getAnalyzedNews(name) {
    if (!process.env.GEMINI_API_KEY) return "AI 분석 설정을 확인해주세요.";

    const now = Date.now();
    const cached = ANALYSIS_CACHE.get(name);

    // 1. 이미 분석된 최신 데이터가 있으면 즉시 반환
    if (cached && (now - cached.timestamp < CACHE_TTL)) {
        console.log(`[Cache] Returning cached analysis for ${name}`);
        return cached.text;
    }

    const analysisPromise = (async () => {
        try {
            const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(name)}+주식&hl=ko&gl=KR&ceid=KR:ko`;
            const response = await axios.get(rssUrl, { timeout: 1500 });
            const xml = response.data;

            // 더 빠른 분석을 위해 뉴스 2개로 압축
            const titles = Array.from(xml.matchAll(/<title>([^<]+)<\/title>/g)).map(m => m[1]).slice(2, 4);
            if (titles.length === 0) return "분석할 최신 뉴스가 없습니다.";

            const prompt = `주식 '${name}'의 최근 뉴스 2개를 요약하고 투자 의견을 주세요.
            형식:
            📢긍정: [한 줄]
            ⚠️부정: [한 줄]
            📊의견: [매수/매도/보류 등]
            
            뉴스:
            ${titles.join('\n')}`;

            try {
                const startTime = Date.now();
                const result = await model.generateContent({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: { maxOutputTokens: 4000, temperature: 0.1 }
                });
                const analysisText = result.response.text().trim();

                // 캐시에 저장
                ANALYSIS_CACHE.set(name, { text: analysisText, timestamp: Date.now() });
                console.log(`[Gemini] Success: ${name} (${Date.now() - startTime}ms)`);
                return analysisText;

            } catch (apiError) {
                console.error("[Gemini Error]:", apiError.message, apiError.status);
                if (apiError.status === 429) return "⚠️ API 할당량 초과입니다. 잠시 후 시도해주세요.";
                if (apiError.message?.includes('quota')) return "⚠️ 사용 한도가 모두 소모되었습니다.";
                return "⚠️ AI 분석 중 일시적인 오류가 발생했습니다.";
            }
        } catch (e) {
            return "현재 뉴스 데이터를 가져올 수 없습니다.";
        }
    })();

    // 3.8초 타임아웃 (카카오톡 5초 제한 대응 안전선)
    const timeoutPromise = new Promise((resolve) =>
        setTimeout(() => {
            console.warn(`[Timeout/Background] ${name} analysis continuing in background...`);
            resolve("🚀 뉴스 분석이 진행 중입니다! 3~5초 후 다시 검색하시면 AI 분석 결과를 즉시 확인하실 수 있습니다.");
        }, 3800)
    );

    return Promise.race([analysisPromise, timeoutPromise]);
}

app.post('/stock', async (req, res) => {
    try {
        const utterance = req.body.userRequest?.utterance;
        if (!utterance) throw new Error('Empty utterance');

        // 1. 발화에서 종목명 추출 (유연한 검색 허용)
        let stockName = utterance
            .replace(/^주식\s*[:：]?\s*/, '') // "주식 :" 제거
            .replace(/\s*어때\??$/, '')        // "어때?" 제거
            .replace(/\s*주가\??$/, '')        // "주가?" 제거
            .trim();

        if (!stockName) {
            return res.json({ version: "2.0", template: { outputs: [{ simpleText: { text: "종목명을 입력해주세요." } }] } });
        }

        console.log(`[Request] Resolved stockName: [${stockName}]`);

        // 2. 티커 찾기 (이름과 티커를 함께 가져오도록 시도)
        let ticker = await findTicker(stockName);
        if (!ticker) {
            const isIntentionalSearch = utterance.startsWith("주식");
            const failText = isIntentionalSearch
                ? `'${stockName}' 종목을 찾을 수 없습니다. (예: 삼성전자, 테슬라)`
                : `죄송해요, '${stockName}' 주식 정보를 찾지 못했습니다. 종목명을 정확히 입력해 주세요!`;

            return res.json({
                version: "2.0",
                template: { outputs: [{ simpleText: { text: failText } }] }
            });
        }

        // 3. 주가 및 뉴스 병렬 수집
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

        // 이름 보정: 야후 파이낸스 이름이 부실하면 사용자가 검색한 이름을 사용
        const displayName = (info.name === ticker || /^[0-9.]+$/.test(info.name) || info.name.length < 2)
            ? stockName.toUpperCase()
            : info.name;

        const priceText = `📈 ${displayName} (${ticker})\n현재가: ${info.price.toLocaleString()} ${info.currency}\n변동: ${info.change > 0 ? '▲' : '▼'} ${Math.abs(info.change).toLocaleString()} (${info.changePercent?.toFixed(2)}%)`;

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

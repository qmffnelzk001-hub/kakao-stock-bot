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

/**
 * 주식 종목명으로 티커(Ticker) 검색 또는 직접 입력 처리
 */
async function findTicker(input) {
    const cleanInput = input.trim().toUpperCase();
    console.log(`[TickerCheck] Input: "${input}", Clean: "${cleanInput}"`);

    // 1. 한국 주식 코드(6자리 숫자)인 경우 -> 가장 우선 처리
    if (/^\d{6}$/.test(cleanInput)) {
        const ticker = `${cleanInput}.KS`;
        console.log(`[TickerCheck] 6-digit code detected. Mapping to: ${ticker}`);
        return ticker;
    }

    // 2. 이미 마침표를 포함한 티커 형식이거나 명확한 해외 티커인 경우
    if (/^[0-9A-Z.]+$/.test(cleanInput)) {
        if (cleanInput.includes('.') || (cleanInput.length >= 2 && !/^\d+$/.test(cleanInput))) {
            console.log(`[TickerCheck] Direct ticker recognized: ${cleanInput}`);
            return cleanInput;
        }
    }

    try {
        console.log(`[TickerSearch] Searching via Yahoo Finance: ${input}`);
        const results = await yahooFinance.search(input);
        if (results.quotes && results.quotes.length > 0) {
            const ticker = results.quotes[0].symbol;
            console.log(`[TickerSearch] Found ticker: ${ticker} (${results.quotes[0].shortname || 'N/A'})`);
            return ticker;
        } else {
            console.log(`[TickerSearch] No results found for: ${input}`);
        }
    } catch (error) {
        console.error(`[TickerSearch] Error searching for "${input}":`, error.message);
    }
    return null;
}

/**
 * 실시간 주가 정보 가져오기
 */
async function getStockPrice(ticker) {
    try {
        console.log(`[StockPrice] Fetching quote for: ${ticker}`);
        const quote = await yahooFinance.quote(ticker);
        if (!quote || quote.regularMarketPrice === undefined) {
            console.warn(`[StockPrice] No price data for: ${ticker}`);
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
        console.error(`[StockPrice] Error for ${ticker}:`, error.message);
        return null;
    }
}

/**
 * 뉴스 검색 및 Gemini 분석
 */
async function getAnalyzedNews(name) {
    try {
        // 구글 뉴스 RSS 활용
        const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(name)}+주식&hl=ko&gl=KR&ceid=KR:ko`;
        const response = await axios.get(rssUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 3500 // 타임아웃 약간 상향
        });
        const xml = response.data;

        const titleMatches = Array.from(xml.matchAll(/<title>([^<]+)<\/title>/g));
        const linkMatches = Array.from(xml.matchAll(/<link>([^<]+)<\/link>/g));

        const rawTitles = titleMatches.map(m => m[1]).slice(1, 6);
        const rawLinks = linkMatches.map(m => m[1]).slice(1, 6);

        if (rawTitles.length === 0) {
            return "최근 관련 뉴스를 찾을 수 없습니다.";
        }

        const prompt = `
            다음은 '${name}' 주식과 관련된 최신 뉴스 제목들입니다.
            호재와 악재를 짧게 요약해줘.
            
            📢 [호재]
            - 내용...
            
            ⚠️ [악재]
            - 내용...
            
            뉴스:
            ${rawTitles.join('\n')}
        `;

        const result = await model.generateContent(prompt);
        const analysisText = result.response.text().trim();

        let finalResponse = analysisText + "\n\n🔗 관련 링크:\n";
        for (let i = 0; i < Math.min(2, rawTitles.length); i++) {
            finalResponse += `- ${rawTitles[i]}\n  ${rawLinks[i]}\n`;
        }

        return finalResponse;
    } catch (error) {
        console.error('뉴스 분석 오류:', error.message);
        return "뉴스 분석 중입니다. 잠시 후 주가와 함께 다시 확인해주세요.";
    }
}

// 카카오톡 챗봇 스킬 엔드포인트
app.post('/stock', async (req, res) => {
    try {
        const userRequest = req.body.userRequest;
        if (!userRequest || !userRequest.utterance) {
            return res.json({ version: "2.0", template: { outputs: [{ simpleText: { text: "요청이 올바르지 않습니다." } }] } });
        }

        const utterance = userRequest.utterance;
        // "주식 : 삼성전자", "삼성전자", "005930" 모두 대응
        let stockName = utterance.replace(/^주식\s*[:：]?\s*/, '').trim();

        if (!stockName) {
            return res.json({
                version: "2.0",
                template: {
                    outputs: [{ simpleText: { text: "조회할 종목명이나 코드를 입력해주세요.\n(예: 삼성전자 또는 005930)" } }]
                }
            });
        }

        console.log(`Processing: [${stockName}]`);

        // 1. 티커 확인
        const ticker = await findTicker(stockName);
        if (!ticker) {
            return res.json({
                version: "2.0",
                template: {
                    outputs: [{ simpleText: { text: `'${stockName}' 종목을 찾을 수 없습니다.\n정확한 종목명이나 티커(예: 005930.KS)를 입력해주세요.` } }]
                }
            });
        }

        // 2. 데이터 병렬 처리
        const [info, analysis] = await Promise.all([
            getStockPrice(ticker),
            getAnalyzedNews(stockName)
        ]);

        if (!info) {
            return res.json({
                version: "2.0",
                template: {
                    outputs: [{ simpleText: { text: `'${ticker}'의 주가 정보를 가져올 수 없습니다. 티커가 정확한지 확인해주세요.` } }]
                }
            });
        }

        const priceText = `📈 ${info.name} (${ticker})\n현재가: ${info.price.toLocaleString()} ${info.currency}\n변동: ${info.change > 0 ? '▲' : '▼'} ${Math.abs(info.change).toLocaleString()} (${info.changePercent.toFixed(2)}%)`;

        res.json({
            version: "2.0",
            template: {
                outputs: [
                    {
                        simpleText: {
                            text: `${priceText}\n\n${analysis}`
                        }
                    }
                ]
            }
        });

    } catch (error) {
        console.error('Final Catch Error:', error.message);
        res.json({
            version: "2.0",
            template: {
                outputs: [{ simpleText: { text: "죄송합니다. 서버 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요." } }]
            }
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`카카오톡 주식 봇 서버가 포트 ${PORT}에서 실행 중입니다.`);
});


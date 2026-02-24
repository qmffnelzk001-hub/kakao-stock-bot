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
 * 주식 종목명으로 티커(Ticker) 검색
 */
async function findTicker(name) {
    try {
        console.log(`Searching for ticker: ${name}`);
        const results = await yahooFinance.search(name);
        if (results.quotes && results.quotes.length > 0) {
            // 가장 유사한 첫 번째 결과 반환 (한국 주식 우선 순위 고려 가능)
            const ticker = results.quotes[0].symbol;
            console.log(`Found ticker: ${ticker}`);
            return ticker;
        }
    } catch (error) {
        console.error('Ticker 검색 오류:', error.message);
    }
    return null;
}

/**
 * 실시간 주가 정보 가져오기
 */
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
        console.error('주가 조회 오류:', error.message);
        return null;
    }
}

/**
 * 뉴스 검색 및 Gemini 분석
 */
async function getAnalyzedNews(name) {
    try {
        // 구글 뉴스 RSS 활용 (User-Agent 추가하여 차단 방지)
        const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(name)}+주식&hl=ko&gl=KR&ceid=KR:ko`;
        const response = await axios.get(rssUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 3000 // 3초 타임아웃
        });
        const xml = response.data;

        // 간단한 XML 파싱 (정규식 활용)
        const titleMatches = Array.from(xml.matchAll(/<title>([^<]+)<\/title>/g));
        const linkMatches = Array.from(xml.matchAll(/<link>([^<]+)<\/link>/g));

        // 상위 5개 뉴스만 분석 (속도 향상 및 토큰 절약)
        const rawTitles = titleMatches.map(m => m[1]).slice(1, 6);
        const rawLinks = linkMatches.map(m => m[1]).slice(1, 6);

        if (rawTitles.length === 0) {
            return "최근 관련 뉴스를 찾을 수 없습니다.";
        }

        const prompt = `
            다음은 '${name}' 주식과 관련된 최신 뉴스 제목들입니다.
            호재(긍정)와 악재(부정)로 나누어 아주 짧게 핵심만 요약해줘.
            
            형식:
            📢 [호재]
            - 요약...
            
            ⚠️ [악재]
            - 요약...
            
            뉴스:
            ${rawTitles.join('\n')}
        `;

        // Gemini 분석 (타임아웃 고려하여 신속하게 수행)
        const result = await model.generateContent(prompt);
        const analysisText = result.response.text().trim();

        let finalResponse = analysisText + "\n\n🔗 관련 링크:\n";
        for (let i = 0; i < Math.min(2, rawTitles.length); i++) {
            finalResponse += `- ${rawTitles[i]}\n  ${rawLinks[i]}\n`;
        }

        return finalResponse;
    } catch (error) {
        console.error('뉴스 분석 오류:', error.message);
        return "뉴스를 분석하는 중에 문제가 발생했습니다. (타임아웃 혹은 서비스 일시 오류)";
    }
}

// 카카오톡 챗봇 스킬 엔드포인트
app.post('/stock', async (req, res) => {
    try {
        const userRequest = req.body.userRequest;
        if (!userRequest || !userRequest.utterance) {
            throw new Error('올바르지 않은 요청 형식입니다.');
        }

        const utterance = userRequest.utterance;
        const stockName = utterance.replace(/주식\s*:\s*/, '').trim();

        if (!stockName) {
            return res.json({
                version: "2.0",
                template: {
                    outputs: [{ simpleText: { text: "조회할 종목명을 입력해주세요.\n(예: 주식 : 삼성전자)" } }]
                }
            });
        }

        console.log(`Processing request for: ${stockName}`);

        // 1. 티커 찾기
        const ticker = await findTicker(stockName);
        if (!ticker) {
            return res.json({
                version: "2.0",
                template: {
                    outputs: [{ simpleText: { text: `'${stockName}' 종목을 찾을 수 없습니다. 정확한 이름을 입력하거나 티커(예: 005930.KS)를 직접 입력해보세요.` } }]
                }
            });
        }

        // 2. 주가 정보 및 뉴스 분석 병렬 처리 (속도 향상)
        const [info, analysis] = await Promise.all([
            getStockPrice(ticker),
            getAnalyzedNews(stockName)
        ]);

        if (!info) {
            throw new Error('주가 정보를 가져오는데 실패했습니다.');
        }

        const priceText = `📈 ${info.name} (${ticker})\n현재가: ${info.price.toLocaleString()} ${info.currency}\n변동: ${info.change > 0 ? '▲' : '▼'} ${info.change.toLocaleString()} (${info.changePercent.toFixed(2)}%)`;

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
        console.error('전체 처리 오류:', error.message);
        res.json({
            version: "2.0",
            template: {
                outputs: [{ simpleText: { text: "데이터 조회 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요." } }]
            }
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`카카오톡 주식 봇 서버가 포트 ${PORT}에서 실행 중입니다.`);
});


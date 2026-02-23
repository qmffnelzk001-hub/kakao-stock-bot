const express = require('express');
const axios = require('axios');
const yahooFinance = require('yahoo-finance2').default;
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

/**
 * 주식 종목명으로 티커(Ticker) 검색
 * @param {string} name - 종목명 (예: 삼성전자)
 * @returns {Promise<string|null>} - 티커 코드 (예: 005930.KS)
 */
async function findTicker(name) {
    try {
        const results = await yahooFinance.search(name);
        if (results.quotes && results.quotes.length > 0) {
            // 가장 유사한 첫 번째 결과 반환
            return results.quotes[0].symbol;
        }
    } catch (error) {
        console.error('Ticker 검색 오류:', error);
    }
    return null;
}

/**
 * 실시간 주가 정보 가져오기
 * @param {string} ticker - 티커 코드
 * @returns {Promise<Object>} - 주가 정보
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
        console.error('주가 조회 오류:', error);
        return null;
    }
}

/**
 * 뉴스 검색 및 Gemini 분석
 * @param {string} name - 종목명
 * @returns {Promise<string>} - 분석된 결과 텍스트
 */
async function getAnalyzedNews(name) {
    try {
        // 구글 뉴스 RSS 활용 (네이버 API 없을 때 대안)
        const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(name)}+주식&hl=ko&gl=KR&ceid=KR:ko`;
        const response = await axios.get(rssUrl);
        const xml = response.data;
        
        // 간단한 XML 파싱 (정규식 활용)
        const titles = [];
        const links = [];
        const titleMatches = xml.matchAll(/<title>([^<]+)<\/title>/g);
        const linkMatches = xml.matchAll(/<link>([^<]+)<\/link>/g);
        
        let count = 0;
        const rawTitles = Array.from(titleMatches).map(m => m[1]).slice(1, 11); // 첫 번째는 RSS 제목이므로 제외
        const rawLinks = Array.from(linkMatches).map(m => m[1]).slice(1, 11);

        const prompt = `
            다음은 '${name}' 주식과 관련된 최신 뉴스 제목들입니다.
            이 뉴스들을 분석하여 '호재(긍정)' 뉴스와 '악재(부정)' 뉴스로 분류하고, 각각의 주요 내용을 아주 짧게 요약해줘.
            관련 링크는 내가 나중에 붙일테니 뉴스 제목과 요약만 해줘.
            
            형식:
            📢 [호재 뉴스]
            - 내용 요약...
            
            ⚠️ [악재 뉴스]
            - 내용 요약...
            
            만약 뚜렷한 호재나 악재가 없다면 일반적인 현황으로 알려줘.
            
            뉴스 리스트:
            ${rawTitles.join('\n')}
        `;

        const result = await model.generateContent(prompt);
        const analysisText = result.response.text();

        // 분석 결과에 링크 매칭 (상위 3개 정도만 추가 정보로 제공)
        let finalResponse = analysisText + "\n\n🔗 관련 링크:\n";
        for (let i = 0; i < Math.min(3, rawTitles.length); i++) {
            finalResponse += `- ${rawTitles[i]}\n  ${rawLinks[i]}\n`;
        }

        return finalResponse;
    } catch (error) {
        console.error('뉴스 분석 오류:', error);
        return "뉴스를 분석하는 중에 문제가 발생했습니다.";
    }
}

// 카카오톡 챗봇 스킬 엔드포인트
app.post('/stock', async (req, res) => {
    const utterance = req.body.userRequest.utterance; // 사용자 입력 (예: 주식 : 삼성전자)
    const stockName = utterance.replace(/주식\s*:\s*/, '').trim();

    if (!stockName) {
        return res.json({
            version: "2.0",
            template: {
                outputs: [{ simpleText: { text: "분석할 종목명을 입력해주세요. (예: 주식 : 삼성전자)" } }]
            }
        });
    }

    try {
        // 1. 티커 찾기
        const ticker = await findTicker(stockName);
        if (!ticker) {
            throw new Error('종목을 찾을 수 없습니다.');
        }

        // 2. 주가 정보 가져오기
        const info = await getStockPrice(ticker);
        
        // 3. 뉴스 분석 및 요약
        const analysis = await getAnalyzedNews(stockName);

        const priceText = `📈 ${info.name} (${ticker})\n현재가: ${info.price.toLocaleString()} ${info.currency}\n변동: ${info.change > 0 ? '▲' : '▼'} ${info.change.toFixed(2)} (${info.changePercent.toFixed(2)}%)`;

        const responseBody = {
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
        };

        res.json(responseBody);

    } catch (error) {
        res.json({
            version: "2.0",
            template: {
                outputs: [{ simpleText: { text: `오류가 발생했습니다: ${error.message}` } }]
            }
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`카카오톡 주식 봇 서버가 포트 ${PORT}에서 실행 중입니다.`);
});

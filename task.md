# 🤖 카카오톡 주식 봇 개발 프로젝트 (Task)

사용자가 입력한 종목의 주가와 뉴스(호재/악재)를 Gemini AI로 분석하여 응답하는 봇입니다.

## 완료된 작업
- [x] 프로젝트 디렉토리 생성 (`kakao-stock-bot`)
- [x] 필수 패키지 설치 (`express`, `axios`, `yahoo-finance2`, `@google/generative-ai`, `dotenv`)
- [x] `.env` 설정 (Gemini API 키 포함)
- [x] 메인 서버 로직 구현 (`index.js`)
    - [x] Yahoo Finance 연동 (실시간 주가 조회)
    - [x] Google News RSS 연동 (최신 뉴스 수집)
    - [x] Gemini AI 연동 (호재/악재 뉴스 분석 및 요약)
    - [x] 카카오톡 스킬 규격에 맞춘 응답 처리

- [x] 서버 안정성 테스트 및 디버깅
    - [x] yahoo-finance2 v3 버전 변경 대응 (인스턴스 생성 방식 적용)
    - [x] 타임아웃 방지를 위한 병렬 처리 및 뉴스 분석 개수 최적화
    - [x] **Gemini 2.0 Flash 모델로 업데이트 및 안전 설정(Safety Settings) 적용 (연결 실패 및 차단 이슈 해결)**
- [x] 카카오 i 오픈빌더 연동 가이드 작성 (`walkthrough.md`)

## 향후 계획
- [ ] 네이버 검색 API 연동 (더 정확한 뉴스 검색을 위함)
- [ ] 관심 종목 등록 기능 추가

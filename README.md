# AI 페이지 번역기

현재 보고 있는 웹 페이지를 원본 언어와 무관하게 **한국어로 번역**하는 Chrome 확장 프로그램(Manifest V3). LLM 프로바이더로 **OpenAI**, **OpenRouter**, **LaoZhang AI**, **Gemini**를 지원하며, 추후 다른 프로바이더로 확장할 수 있도록 설계함. LaoZhang AI는 OpenAI 호환 Chat Completions API를, Gemini는 Google의 **Interactions API**를 사용함.

## 주요 기능

- 확장 아이콘(팝업)의 **"이 페이지 번역"** 버튼을 누를 때만 번역을 실행함. 페이지 진입 시 자동 번역하지 않음.
- 뷰포트에 보이는 텍스트부터 번역하며, **스크롤로 새 영역이 나타나면 이어서 번역**함(`IntersectionObserver`).
- 무한 스크롤 등으로 DOM이 동적으로 추가되면 자동으로 감지해 번역함(`MutationObserver`).
- 사용자가 **API 키**와 **모델명**을 직접 입력함(예: OpenAI `gpt-5.4-mini`, OpenRouter `deepseek/deepseek-v4-flash`, LaoZhang AI `gpt-4o-mini`, Gemini `gemini-3.1-flash-lite`).
- **프로바이더별 자격증명 저장**: OpenAI/OpenRouter/LaoZhang AI/Gemini 각각의 API 키·모델을 따로 저장하며, 프로바이더를 전환하면 해당 프로바이더에 저장한 값이 자동으로 표시됨.
- **말투 선택**: 페이지 전체를 일관된 **반말(기사체)** 또는 **존댓말(합니다체)** 로 번역하거나, **캐주얼체(게시판)** 로 화자마다 다른 격식과 친밀도를 유지함. 캐주얼체는 Reddit 같은 일반 게시판에 맞춰 반말·해요체·합니다체·높은 존칭을 원문의 태도에 따라 선택하되, 과격한 커뮤니티 고유 말투나 불필요한 비속어를 만들지 않음.
- **추론 강도 조정**: 추론(reasoning) 모델이 번역 전에 사고 과정을 길게 도는 것을 줄임. 없음(기본)/최소/낮음/모델 기본값 중 선택. 프로바이더별로 올바른 형식(OpenAI `reasoning_effort`, OpenRouter `reasoning` 객체, Gemini `generation_config.thinking_level`)만 전송함. LaoZhang AI는 공식 API 매뉴얼에 추론 파라미터가 명시되어 있지 않아 해당 설정을 전송하지 않음. Gemini에는 완전 비활성 값이 없어 `없음`을 `minimal`로 매핑하며, 모델이 거부하면 모델 기본값으로 자동 폴백함.
- **용어집(고정 번역)**: 특정 고유명사·용어를 항상 지정한 번역으로 치환함(예: `Sam Altman=샘 올트먼`). 설정에 저장되어 재사용됨.
- **자동 재시도**: 일시적 오류(네트워크 오류·429 레이트리밋·5xx 서버 오류·빈 응답)는 지수 백오프로 자동 재시도함(배치당 최대 2회). 인증 오류(401/403) 등 영구 오류와 **요청 타임아웃(60초 무응답)**은 즉시 실패시킴(그 모델이 감당 못 하는 것으로 보고 재시도하지 않음).
- **배치 크기/문자 수 캡 조정**: 한 요청에 담는 세그먼트 수(1~100, 기본 30)와 문자 수 캡(500~20000, 기본 5000)을 설정에서 조정할 수 있음. 배치는 둘 중 먼저 도달하는 쪽에서 끊김. 느린 모델은 작게 잡으면 배치당 응답이 빨라져 타임아웃 위험이 줄어듦.
- **동시 실행(병렬 요청)**: 한 번의 플러시에서 여러 배치를 동시에 요청함(1~10, 기본 3). 배치들은 서로 독립적으로 치환되므로, 동시 실행 수를 높이면 배치당 왕복 지연이 누적되지 않아 전체 번역이 빨라짐. 레이트리밋(429)이 자주 발생하면 값을 낮춤.
- **요청 타임아웃 조정**: 배치당 응답 대기 시간(10~300초, 기본 60초)을 설정에서 조정할 수 있음. 초과하면 재시도 없이 실패 처리함.
- **출력 토큰 자동 산정**: 배치 크기에 비례해 OpenAI/OpenRouter의 `max_completion_tokens`, LaoZhang AI의 `max_tokens` 또는 Gemini의 `generation_config.max_output_tokens`를 자동 설정함. 추론 토큰까지 고려해 여유분을 더해 잘림을 방지함.
- **Gemini 구조화 출력**: Interactions API의 `response_format`에 배치 키별 JSON Schema를 제공해 번역 응답 형태를 강제함. 페이지 번역 요청은 대화 상태가 필요 없으므로 `store:false`로 실행함.
- **디버그 로그**: 설정에서 켜면 요청·응답 상세를 콘솔에 출력하여 간헐적 실패의 원인을 추적할 수 있음(아래 [디버깅](#디버깅) 참고).

## 설치 (개발자 모드)

1. Chrome 에서 `chrome://extensions` 접속.
2. 우측 상단 **개발자 모드** 활성화.
3. **압축해제된 확장 프로그램을 로드** 클릭 후 이 디렉토리(`ai_translator`) 선택.

## 사용법

1. 툴바의 확장 아이콘 클릭.
2. 처음에는 **설정** 영역이 펼쳐짐. **API 키**와 **모델명**을 입력하고 **설정 저장** 클릭.
   - **말투**를 반말/존댓말/캐주얼체 중에서 선택함(기본값: 반말). 캐주얼체는 배치 전체를 한 말투로 통일하지 않고 각 게시물·댓글의 화자와 문맥에서 드러나는 격식 수준을 유지함.
   - **추론 강도**를 선택함(기본값: 없음). 느린 추론 모델은 없음/최소로 두면 사고 과정이 줄어 응답이 빨라짐. 모델이 특정 값을 거부해도 지원되는 값으로 자동 폴백함.
   - **용어집**에 한 줄에 하나씩 `원문=번역` 형식으로 입력함. 구분자는 `=`, `=>`, `->`, `→`, 탭을 지원하고, `#`로 시작하는 줄은 주석으로 무시함.
   - **배치 크기**(1~100, 기본 30)와 **배치 문자 수 캡**(500~20000, 기본 5000)을 조정할 수 있음. 배치는 둘 중 먼저 도달하는 쪽에서 끊기며, 느린 모델일수록 작게 설정하면 배치당 응답이 빨라짐.
   - **동시 실행 수**(1~10, 기본 3)를 조정할 수 있음. 높일수록 여러 배치를 동시에 요청해 전체 번역이 빨라지지만, 레이트리밋(429)이 자주 나면 낮춤.
   - **요청 타임아웃**(10~300초, 기본 60초)을 조정할 수 있음. 초과 시 재시도 없이 실패함.
   - 문제 진단이 필요하면 **디버그 로그**를 켬(아래 [디버깅](#디버깅) 참고).
3. 번역할 페이지에서 아이콘을 눌러 **"이 페이지 번역"** 클릭.
4. 화면에 보이는 부분부터 번역되며, 스크롤하면 나머지도 순차 번역됨.
5. 진행 상태는 페이지 우하단 토스트로 표시됨.

## 구조

```
ai_translator/
  manifest.json          # MV3 매니페스트
  popup.html             # 팝업 UI (번역 버튼 + 설정)
  popup.js               # 팝업 로직 (설정 저장, 번역 시작 신호 전송)
  styles.css             # 팝업 스타일
  src/
    background.js        # 서비스 워커 (LLM API 호출 중계, 프로바이더별 설정 관리)
    content.js           # 콘텐츠 스크립트 (DOM 텍스트 수집/치환, 뷰포트 감지)
    providers/
      openai-compatible.js  # OpenAI 호환 공통 로직 (프롬프트 구성 + fetch)
      openai.js             # OpenAI 프로바이더 (엔드포인트 지정 래퍼)
      openrouter.js         # OpenRouter 프로바이더 (엔드포인트 지정 래퍼)
      laozhang.js           # LaoZhang AI 프로바이더 (엔드포인트 지정 래퍼)
      gemini.js             # Gemini Interactions API 프로바이더
```

### 동작 흐름

1. 팝업의 번역 버튼 → 활성 탭의 `content.js` 에 `start-translation` 메시지 전송.
2. `content.js` 가 뷰포트에 들어온 텍스트 노드를 배치로 묶어 `background.js` 에 `translate-batch` 요청.
3. `background.js` 가 저장된 설정으로 선택된 프로바이더를 호출해 번역 결과 반환.
4. `content.js` 가 원문 텍스트 노드를 번역문으로 치환(앞뒤 공백 보존).

> API 호출을 서비스 워커에서 수행하는 이유: 페이지의 CSP 제약을 우회하고, API 키를 페이지 컨텍스트에 노출하지 않기 위함.

## 프로바이더 확장 방법

OpenAI 호환(Chat Completions) API라면 `openai-compatible.js` 의 `createTranslator`로 엔드포인트만 지정해 손쉽게 추가할 수 있음(예: `openrouter.js`). 호환되지 않는 API는 `translateSegments({ apiKey, model, segments, tone, glossary, reasoningEffort, timeoutMs, debug })` 시그니처를 직접 구현함(입력과 동일한 길이·순서의 한국어 배열 반환). `gemini.js`가 Interactions API를 직접 구현하는 예임.

1. `src/providers/` 에 새 파일을 만들고 `translateSegments` 를 export 함. OpenAI 호환이면 `createTranslator({ endpoint, label, extraHeaders })` 를 재사용함.
2. `src/background.js` 의 `PROVIDERS` 레지스트리에 항목을 추가함.
3. `popup.html` 의 프로바이더 `<select>` 에 옵션을 추가하고, `popup.js` 의 `PROVIDER_META` 에 입력 힌트를 등록함.
4. 프로바이더별 엔드포인트가 페이지가 아닌 서비스 워커에서 호출되므로, `manifest.json` 의 `host_permissions` 에 해당 API 도메인을 추가함.

> API 키와 모델은 프로바이더별로 `chrome.storage.local` 의 `credentials[provider] = { apiKey, model }` 에 저장됨. 과거 단일 형식(최상위 `apiKey`/`model`)으로 저장된 값은 OpenAI 자격증명으로 자동 이관됨.

### LaoZhang AI 설정

LaoZhang AI는 공식 문서가 해외 직접 연결용으로 제공하는 백업 엔드포인트 `https://api-vip.laozhang.ai/v1`을 사용함. 기본 도메인이 AdGuard 브라우징 보안에서 오탐 차단되는 환경에서도 광고 차단과 브라우징 보안을 유지하기 위한 선택임. LaoZhang AI 콘솔에서 발급한 API 키와 지원 모델명을 팝업에 입력하면 됨. 요청은 `Authorization: Bearer <API_KEY>` 헤더로 인증하며, 확장 프로그램은 전체 경로 `https://api-vip.laozhang.ai/v1/chat/completions`를 호출함.

## 디버깅

번역이 간헐적으로 실패할 때(특히 OpenRouter) 원인을 추적하는 방법.

1. 팝업 설정에서 **디버그 로그** 체크박스를 켜고 저장함. 요청/응답 상세가 콘솔에 출력됨.
2. **서비스 워커 콘솔**(가장 중요): `chrome://extensions` → 확장 카드의 **"서비스 워커"** 클릭 → DevTools.
   - `[ai_translator ...] [background/handleTranslate] ...` 및 프로바이더 로그로 요청·소요시간·라우팅된 모델(`routedModel`/`provider`)·레이트리밋 헤더를 확인함.
   - **Network** 탭에서 `chat/completions` 또는 Gemini `v1beta/interactions` 요청의 실제 상태 코드·응답 본문을 볼 수 있음.
3. **페이지 콘솔**(F12): `content.js` 가 배치별 전송/적용 및 오류를 로깅함. 오류 토스트는 자동으로 사라지지 않으며 클릭하면 닫힘.

오류 메시지 자체에 진단 정보가 포함됨:

| 메시지 | 의미 |
|--------|------|
| `... API error (429): ...` | 레이트리밋/크레딧 초과 — 잠시 후 재시도 |
| `... API error (401/403)` | API 키·권한 오류 |
| `... API error (400)` | 모델명 오타(OpenRouter 슬러그), 요청 형식 오류 |
| `... API returned HTML instead of JSON (HTTP ...)` | API 게이트웨이·WAF의 차단/점검 페이지가 반환됨. 디버그 로그와 Network 응답 본문 확인 필요 |
| `failed to parse model response as JSON: <원문>` | 모델이 JSON을 지키지 않음(해당 모델이 `response_format` 미지원일 수 있음). 다른 모델로 교체 권장 |
| `failed to parse model response as JSON: (empty content)` | 빈 응답(라우팅 실패·타임아웃 등) |
| `network error: ...` | 네트워크 오류 또는 `host_permissions` 누락 |

> OpenRouter는 요청마다 상위 모델/공급자로 라우팅되므로, 특정 슬러그가 JSON 형식을 불안정하게 지키면 성공/실패가 섞일 수 있음. 이때는 디버그 로그의 `routedModel`을 확인하고 JSON 출력이 안정적인 모델로 바꾸는 것이 근본 해결책임.

### 세그먼트 개수 불일치 처리

번역 요청은 세그먼트를 **인덱스 키 객체**(`{"segments": {"0": "...", ...}}`)로 주고받음. 모델이 링크 텍스트 조각 등을 병합/누락해도 키 기준으로 원문 순서에 맞춰 재구성하므로, 개수가 어긋나도 배치 전체를 버리지 않음. 번역이 누락된 세그먼트만 원문을 유지하고 나머지는 정상 반영함. 디버그 로그에 `filled N/M segments with original text` 로 누락 개수가 표시됨. 특정 세그먼트가 자주 원문으로 남으면 그 부분이 잘게 쪼개진 인라인 요소(링크 등)일 가능성이 큼.

또한 소형 모델은 지시한 응답 스키마를 매번 지키지 않으므로, 응답 파싱은 여러 형태를 허용함: 래퍼 유무(`{"translations": {...}}` vs `{"0": ...}`)와 객체/배열 모두 인식함. 이 중 어느 것으로도 해석되지 않을 때만 `response has no usable translations` 오류를 냄.

### response_format(json_object) 미지원 모델

일부 모델(예: 일부 Novita 라우팅 모델)은 `response_format: json_object` 를 지원하지 않고 400(`does not support 'json_object' response format`)을 냄. 이 경우 자동으로 **해당 필드를 빼고 재시도**함(프롬프트가 이미 JSON 을 강하게 지시하므로 대개 정상 동작). 한 번 확인된 모델은 캐시되어 이후 배치는 처음부터 필드를 생략함(불필요한 400 방지). 디버그 로그의 `response_format=json_object|none` 값으로 현재 상태를 확인할 수 있음.

### 느린 모델이 오래 걸리는 경우

느린 모델(예: 일부 OpenRouter 슬러그)은 응답 생성이 끝날 때까지 OpenRouter가 연결 유지용 빈 줄(keep-alive 패딩)을 흘려보내다가 마지막에 완성된 JSON을 한 번에 내려줌. 네트워크 탭 응답 창에서 빈 줄이 늘어나다 끝에 내용이 나오는 것은 이 때문이며, 응답 형식이 깨진 것이 아니라 단순히 **처리 지연**임.

- 지연이 요청 타임아웃(설정값, 기본 60초)을 넘으면 재시도 없이 즉시 실패함(그 모델은 이 작업을 감당 못 하는 것으로 판단). 느린 모델을 계속 쓰려면 설정에서 타임아웃을 늘릴 수 있음.
- 전체 페이지 번역은 배치를 여러 번 호출함. **동시 실행 수**를 높이면 여러 배치를 병렬로 요청해 배치당 지연이 누적되지 않으므로 전체 체감 속도가 크게 개선됨(기본 3). 빠른 모델을 쓰거나 **배치 크기를 줄이는 것**도 함께 효과적임. 단, 동시 실행 수가 지나치게 높으면 레이트리밋(429)이 늘 수 있음.
- **추론 모델이 원인인 경우**: 지연의 상당 부분이 번역 전 사고 과정(reasoning)일 수 있음. 설정에서 **추론 강도를 없음/최소**로 낮추면 크게 빨라짐. 디버그 로그의 `reasoning=` 값으로 실제 전송된 값을 확인할 수 있고(모델이 거부하면 자동 폴백된 값이 표시됨), `finishReason`/응답의 `reasoning_tokens` 로 실제 추론량을 볼 수 있음. 모델마다 지원 값이 달라(예: 일부 OpenAI 모델은 `minimal` 미지원, `none` 지원) 거부 시 지원되는 가장 낮은 값으로 자동 전환됨.

### 재시도/타임아웃 기본값

`src/providers/openai-compatible.js` 상단 상수로 조정함.

| 상수 | 기본값 | 의미 |
|------|--------|------|
| `DEFAULT_REQUEST_TIMEOUT_MS` | 60000 | 배치당 요청 타임아웃 기본값(ms). 설정(초 단위)이 있으면 그 값을 우선 사용 |
| `MAX_RETRIES` | 2 | 최초 시도 외 추가 재시도 횟수 |
| `RETRY_BASE_DELAY_MS` | 1000 | 지수 백오프 기본 지연(ms). 실제 지연 = BASE × 2^(재시도-1) + 지터. 429는 `Retry-After` 헤더 우선 |
| `OUTPUT_TOKENS_PER_CHAR` | 1.3 | 입력 문자당 예상 출력 토큰(한국어, 보수적) |
| `MAX_TOKENS_BUFFER` | 3000 | 추론/안전 여유분(GPT-5 추론 토큰 포함 대비) |
| `MAX_TOKENS_FLOOR` / `MAX_TOKENS_CEILING` | 2000 / 16000 | `max_completion_tokens` 산정값의 하한/상한 |

> `max_completion_tokens` 는 GPT-5 계열에서 **출력 토큰 + 추론 토큰**을 함께 포함하는 상한임. 너무 낮으면 추론이 예산을 소진해 실제 번역이 잘릴 수 있으므로 여유분(`MAX_TOKENS_BUFFER`)을 크게 둠. 문자 수 캡을 매우 크게 올릴 경우 상한(`MAX_TOKENS_CEILING`)과 모델별 최대 출력 한계도 함께 고려해야 함.

## 제약 및 참고

- `chrome://`, 확장 스토어 등 콘텐츠 스크립트가 주입되지 않는 페이지에서는 동작하지 않음.
- 번역은 텍스트 노드 단위로 치환하므로 페이지 스크립트가 DOM 을 다시 렌더링하면 원문으로 되돌아갈 수 있음.
- API 키는 `chrome.storage.local` 에 평문으로 저장됨(로컬 전용).
- 모델 파라미터는 최소한(`model`, `messages`, `response_format`)만 전송하여 최신 모델 호환성을 확보함.

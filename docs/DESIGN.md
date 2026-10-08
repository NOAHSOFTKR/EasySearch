# EasySearch 설계 문서

> 대상 버전: 0.1.0 · 작성일: 2026-10-08

## 1. 저장소 현황 (작업 시작 시점)

- `NOAHSOFTKR/EasySearch` 저장소는 커밋이 하나도 없는 빈 저장소였습니다. 보존해야 할 기존 구현이나 스타일 규칙이 없어서, 요구사항 문서의 구조와 LayerCache 저장소의 관례(TypeScript strict, tsup, Vitest, ESM 우선 + CJS 병행 배포, Node.js 20 이상)를 기준으로 삼았습니다.

## 2. LayerCache 분석 (실제 코드 기준)

`https://github.com/flyingsquirrel0419/layercache` 의 `main` 브랜치(커밋 `2efbf22`, "prepare 5.0.0 release")와 npm `layercache@5.0.0` 을 직접 확인했습니다.

| 항목 | 확인 결과 |
| --- | --- |
| 라이선스 / 엔진 | Apache-2.0, `node >= 20` |
| 모듈 형식 | `exports["."]` → `import: dist/index.js`, `require: dist/index.cjs`, `types: dist/index.d.ts` |
| 런타임 의존성 | `@msgpack/msgpack`, `async-mutex`, **`ioredis` (optionalDependencies + peerDependencies)** → npm 은 기본적으로 ioredis 도 설치합니다 |
| 생성자 | `new CacheStack(layers: CacheLayer[], options?: CacheStackOptions)`, 레이어가 없으면 throw |
| 메모리 레이어 | `new MemoryLayer({ ttl?, maxSize? = 1000, name?, evictionPolicy?, cleanupIntervalMs?, onEvict? })` |
| 읽기 | `get<T>(key, fetcher?, options?: CacheGetOptions): Promise<T \| undefined>` — miss 시 fetcher 실행 후 모든 레이어에 저장 |
| 쓰기/삭제 | `set(key, value, options?)`, `delete(key)`, `clear()`, `mdelete(keys)` |
| 무효화 | `invalidateByTag(tag)`, `invalidateByTags`, `invalidateByPattern`, `invalidateByPrefix`, `namespace(prefix).clear()`, `bumpGeneration()` |
| 종료 | `disconnect()` |
| TTL 단위 | 밀리초 (`CacheEntryWriteOptions.ttl`, `MemoryLayerOptions.ttl`) |
| 동시성 | `stampedePrevention` 기본 활성 (명시적으로 `false` 일 때만 비활성) — 같은 키의 동시 fetch 를 한 번으로 합침 |
| 키 제약 | 1~1024자, 제어문자(U+0000–U+001F, U+007F)·서로게이트 금지 (`validateCacheKey`) |
| 태그 인덱스 | 기본 `TagIndex` 는 프로세스 로컬. 공유 레이어에서 태그 무효화를 다른 프로세스까지 하려면 `RedisTagIndex` 필요 (LayerCache 가 경고 로그로 안내) |
| 프로세스 간 L1 무효화 | `RedisInvalidationBus` + `broadcastL1Invalidation` 옵션 |
| 타입 선언 | `moduleResolution: NodeNext` + `skipLibCheck: false` 에서 `ioredis` 타입 관련 TS2709 오류가 납니다 (LayerCache 자체 문제) |

### EasySearch 가 사용하는 API

`get(key, fetcher, { ttl, tags })`, `set(key, value, { ttl, tags })`, `delete(key)`, `invalidateByTag(tag)`, `disconnect()`, 그리고 기본 캐시 생성용 `CacheStack` / `MemoryLayer` 생성자만 사용합니다. 그 밖의 메서드는 추측해서 쓰지 않았습니다.

### 연동 방식 결정

- **optional peer dependency** (`peerDependenciesMeta.layercache.optional = true`). 일반 의존성으로 두면 LayerCache 의 optionalDependency 인 `ioredis` 까지 모든 사용자에게 설치되기 때문입니다.
- `useLayerCache: true` 이고 `cache` 를 주입하지 않았을 때만 `await import("layercache")` 로 지연 로드합니다. 패키지가 없으면 설치 방법을 안내하는 오류를 던집니다 (조용히 캐시를 끄지 않음).
- 공개 타입은 `layercache` 타입을 import 하지 않고 구조적 인터페이스 `LayerCacheLike` 로 선언했습니다. LayerCache 미설치 환경이나 위의 TS2709 문제와 무관하게 `skipLibCheck: false` 로도 타입 검사가 통과합니다. 실제 `CacheStack` 이 이 인터페이스를 만족하는지는 테스트와 스모크 검사에서 확인합니다.
- 별도 어댑터 패키지는 필요하지 않았습니다. ESM/CJS, LayerCache 설치/미설치, esbuild 번들 모두 `scripts/smoke-pack.mjs` 로 검증했습니다.

## 3. 기존 검색 라이브러리와 비교

| | Fuse.js | MiniSearch | FlexSearch | match-sorter | **EasySearch** |
| --- | --- | --- | --- | --- | --- |
| 방식 | 인덱스 없이 전체 스캔 (Bitap) | 역색인, 토큰 단위 | 고성능 역색인 | 배열 전체 스캔, 순위 단계 | 정규화 값 + 단어 사전(역색인) |
| 부분 문자열 | O (퍼지로) | 접두사만 | 설정에 따라 | O | O (단어 내부 포함) |
| 오타 허용 | O | O (편집 거리) | 제한적 | X | O (OSA 편집 거리) |
| 한글 오타 | 음절 단위 | 음절 단위 | 음절 단위 | X | **자모 단위** ("니아"↔"니야" = 4자 중 1) |
| 데이터 소스 | 배열 | 문서 추가 API | 문서 추가 API | 배열 | **배열 · 동기/비동기 함수 · Provider** |
| 재로드/무효화 정책 | 직접 구현 | 직접 구현 | 직접 구현 | 해당 없음 | `reload` / `invalidate` / `reloadOnSearch` / 실패 시 정책 |
| 캐시 | X | X | X | X | **LayerCache 위임** (메모리/Redis/디스크) |

결론: 순수 검색 알고리즘만 보면 MiniSearch·FlexSearch 와 기능이 겹칩니다. EasySearch 의 차별점은 (1) 데이터 소스와 데이터 수명주기(지연 로드, 재로드, 동시 요청, 실패 정책)를 라이브러리가 맡는 점, (2) LayerCache 로 데이터·결과를 프로세스 간 공유할 수 있는 점, (3) 한국어 자모 단위 오타 허용입니다. 외부 검색 엔진을 감싸면 한글 자모 처리와 부분 문자열 검색을 맞추기 어렵고 런타임 의존성이 생기므로, 검색 엔진은 의존성 없이 직접 구현했습니다.

## 4. 아키텍처

```
src/
  index.ts                  공개 API
  core/
    EasySearch.ts           요청 처리, 데이터 로드/재로드, 캐시 연결
    SearchIndex.ts          인덱스 생성 (정규화 값, 단어 사전, 정확 일치 맵)
    SearchEngine.ts         질의 실행, 점수 합산, 정렬/top-k
  search/
    normalize.ts            정규화, 토큰화, 한글 자모 분해
    matchers.ts             완전/접두사/단어/부분 일치 점수, 퍼지(OSA) 매처
  providers/DataProvider.ts 배열/함수/Provider 통합, DataLoadError
  cache/
    CacheAdapter.ts         LayerCacheLike 인터페이스, 키 유틸
    LayerCacheAdapter.ts    기본 CacheStack 지연 생성
  types/                    options, results, KeyPath
```

요구사항의 `ArrayProvider`/`FunctionProvider`, `ExactMatcher`/`PartialMatcher`/`FuzzyMatcher`, `SearchScorer` 는 각각 수십 줄 규모라 과도한 분리를 피하기 위해 `DataProvider.ts`, `matchers.ts`, `SearchEngine.ts` 로 합쳤습니다.

### 4.1 인덱스 (`SearchIndex`)

데이터 로드 1회당 불변 인덱스 1개를 만듭니다.

- **정규화 값**: `[item × keyCount + key]` 평면 배열. 검색 시 원본 객체를 다시 읽거나 정규화하지 않습니다.
- **단어 사전**: 고유 단어 → (item, key) 쌍 목록(posting). 한 단어 질의는 모든 값이 아니라 단어 사전만 훑고, 퍼지 비교도 단어 등장 횟수가 아닌 고유 단어 수만큼만 수행합니다.
- **정확 일치 맵**: `mode: "exact"` 를 처음 쓸 때 생성 (값 → item 목록).
- **중복 정책**: `idKey` 가 있으면 같은 로드 안에서 처음 나온 항목만 남깁니다(`number 1` 과 `string "1"` 은 다른 id). 없으면 모두 유지합니다.
- **키 자동 탐색**: `keys` 생략 시 원시값 항목은 항목 자체를, 객체는 최상위 문자열/숫자(배열 포함) 속성을 사용합니다.
- 경로에 `__proto__`, `prototype`, `constructor` 세그먼트는 허용하지 않습니다.

### 4.2 정규화와 토큰화

- NFKC (NFD 한글 조합, 전각 문자 접기) → 소문자 → (옵션) 발음 구별 기호 제거 → 공백 압축.
- 단어 = 문자·숫자·결합 문자(`\p{L}\p{N}\p{M}`)의 최대 연속 구간. ASCII 와 한글 음절은 정규식 없이 판별합니다.
- 퍼지 비교용 코드: 한글 음절을 초성/중성/종성 자모로 분해합니다.

### 4.3 매칭과 점수

필드 하나의 점수 대역은 서로 겹치지 않습니다. 대역 안에서는 `질의 길이 / 값 길이`(coverage)가 클수록 높습니다.

| 유형 | 조건 | 점수 |
| --- | --- | --- |
| exact | 값 전체 = 질의 | 1 |
| prefix | 값이 질의로 시작 | 0.8 + 0.1·coverage |
| word | 단어 경계에서 질의 시작 | 0.6 + 0.1·coverage |
| partial | 단어 내부에 질의 포함 | 0.4 + 0.1·coverage |
| fuzzy | 단어가 편집 허용 범위 내 | 0.1 + 0.2·유사도 (긴 질의의 단어 접두사 퍼지는 ×0.75) |

- 항목 점수 = `(가장 높은 가중 필드 점수 + 0.1 × 나머지 가중 필드 점수 합) / 검색 대상 키의 최대 가중치`. 소수 6자리로 반올림해 부동소수 오차가 순서를 정하지 않게 합니다.
- 여러 단어 질의: 모든 단어가 (어느 필드든) 일치해야 합니다(AND). 점수 = max(구문 전체 일치 점수, 0.9 × 단어별 점수 평균).
- 정렬: 점수 내림차순, 동점은 데이터 순서(안정 정렬). `limit` 이 결과의 1/4 미만이면 전체 정렬 대신 크기 `limit` 의 힙으로 선택합니다.
- 퍼지: Optimal String Alignment 거리(치환/삽입/삭제/인접 전치). 기본 허용 편집 수는 자모 기준 길이 1–2: 0, 3–6: 1, 7–11: 2, 12+: 3. 최소 한 글자는 일치해야 하도록 `질의 길이 - 1` 로 상한을 둡니다. 행 최솟값이 연속 두 행에서 허용치를 넘으면 조기 종료합니다.

### 4.4 데이터 수명주기

| 상황 | 동작 |
| --- | --- |
| 생성자 | 검증만 하고 데이터는 읽지 않음 |
| 첫 `search()` | 데이터 로드 → 인덱스 생성 |
| `reloadOnSearch: false` (기본) | 로드된 데이터/인덱스 재사용 |
| `reloadOnSearch: true` | 매 검색 전 로드. 캐시 사용 시 캐시를 거치므로 TTL 이내에는 데이터 소스를 호출하지 않음. 데이터 버전이 같으면 인덱스 재사용 |
| `reload()` | 캐시를 우회해 데이터 소스 호출 → 캐시에 기록 → 인덱스 재생성. 실패 시 reject, 이전 데이터 유지 |
| `invalidate()` | 로컬 데이터를 무효로 표시하고 이 인스턴스의 캐시 항목(데이터 키 + 태그) 삭제. 다음 검색에서 다시 로드 |
| 로드 실패 (검색 중) | 기본: `DataLoadError` 로 reject. `fallbackToStaleOnError: true` 이고 이전 데이터가 있으면 이전 데이터로 검색하고 `onError` 로 보고 |
| `dispose()` | EasySearch 가 만든 캐시만 `disconnect()`. 주입한 캐시는 건드리지 않음. 이후 사용 불가 |

동시성:

- 동시 검색은 진행 중인 로드 하나를 공유합니다 (단일 비행).
- `reload()` 는 항상 새 로드를 시작합니다. 로드가 겹치면 **가장 나중에 시작한 로드**가 이깁니다. 늦게 끝난 오래된 로드는 버려지고, 그 로드를 기다리던 호출자는 더 최신 데이터를 받습니다.
- `invalidate()` 이후의 검색은 그 이전에 시작된 로드를 재사용하지 않습니다.
- 한 번의 검색 결과는 항상 하나의 데이터 로드(스냅샷)에서 나옵니다.

### 4.5 캐시 설계

EasySearch 는 캐시 엔진을 구현하지 않습니다 (LRU/TTL/저장소 없음). 캐시 키 생성, 호출 연결, 인덱스와의 일관성만 담당합니다.

| 항목 | 키 | 값 |
| --- | --- | --- |
| 데이터 | `easysearch:{ns}:data` | `{ version, items }` |
| 결과 | `easysearch:{ns}:result:{설정 지문}:{데이터 버전}:{옵션+질의}` | `[항목 위치, 점수, [키 위치, 일치 유형][]][]` |

- `ns` = `cacheKey` 또는 인스턴스마다 고유한 값 → 기본적으로 인스턴스 간 키 충돌이 없습니다. 같은 `cacheKey` 는 "같은 데이터 소스" 라는 선언이며 데이터를 공유합니다.
- **데이터 버전**은 데이터 소스를 실제로 호출할 때마다 새로 만들어집니다. 결과 키에 버전이 들어가므로, 데이터가 바뀌면 이전 결과는 절대 읽히지 않고 TTL 로 사라집니다. 캐시에서 같은 버전을 다시 읽으면 인덱스도 재사용합니다.
- **설정 지문**(keys, 가중치, idKey, ignoreDiacritics 의 해시)으로 같은 `cacheKey` 를 쓰는 다른 설정끼리 결과를 섞지 않습니다.
- 결과 캐시에는 항목 자체가 아니라 위치만 저장하고 로컬 스냅샷에서 복원합니다 → 캐시 크기가 작고 원본 객체 동일성이 유지됩니다.
- 정적 배열은 데이터 로드를 캐시하지 않고 결과만 캐시합니다. 정적 배열 + `reloadOnSearch: true` 는 매번 버전이 바뀌므로 결과 캐시도 쓰지 않습니다.
- `filter` 함수나 사용자 정의 정렬 함수가 있으면 결과 캐시를 우회합니다 (함수는 키로 만들 수 없음).
- 키가 1024자를 넘는 긴 질의는 결과 캐시를 건너뜁니다. 질의는 JSON 이스케이프 + U+007F 이스케이프로 키 제약을 지킵니다.
- 캐시에서 읽은 값은 모양과 범위를 검증하고, 잘못된 값은 무시하고 `onError` 로 보고합니다.
- 캐시 장애(예: Redis 다운): `get`/`set` 실패는 `onError` 로 보고하고 캐시 없이 검색합니다. 단, `layercache` 미설치(설정 오류)와 데이터 소스 오류는 그대로 전파합니다. `invalidate()` 는 캐시 삭제 실패 시 reject 합니다 (로컬 무효화는 이미 적용).
- 동일 질의 동시 요청은 LayerCache 의 stampede prevention 으로 한 번만 계산됩니다.

## 5. 지원 범위와 제한 사항

- **프로세스 간 일관성**: Redis 등 공유 레이어에서 데이터·결과를 공유할 수 있습니다. 하지만 다른 프로세스의 *로컬 인덱스*는 그 프로세스가 다시 로드할 때까지 바뀌지 않습니다. 실시간에 가깝게 맞추려면 `reloadOnSearch: true`(캐시된 데이터 키를 매 검색 확인)를 쓰고, 메모리 L1 을 함께 쓴다면 LayerCache 의 `RedisInvalidationBus` + `broadcastL1Invalidation` 을 설정해야 합니다.
- `invalidate()` 의 태그 무효화는 LayerCache 기본 `TagIndex` 를 쓰면 현재 프로세스가 기록한 결과 키만 지웁니다. 데이터 키는 직접 삭제하므로 공유 레이어에서도 지워지고, 남은 결과 키는 새 데이터 버전에서 읽히지 않습니다. 결과 키까지 모든 프로세스에서 지우려면 `RedisTagIndex` 를 쓰세요.
- 공유 레이어에 데이터를 캐시하려면 데이터가 직렬화 가능해야 합니다 (`Date` 는 문자열이 되는 등 LayerCache 직렬화 규칙을 따름).
- 검색과 인덱스 생성은 동기 CPU 작업입니다. 10만 건 인덱스 생성은 약 1.1초 동안 이벤트 루프를 점유합니다.
- 1글자처럼 대부분의 항목이 일치하는 질의는 결과 수에 비례해 느립니다 (10만 건 기준 전체 결과 약 160ms, `limit: 20` 약 50ms).
- 퍼지 매칭은 단어 단위입니다. 띄어쓰기 없는 CJK 긴 문장, 단어를 가로지르는 오타는 찾지 못할 수 있습니다. 초성 검색은 지원하지 않습니다.
- 원격 검색(질의를 데이터베이스에 위임) Provider 는 이번 범위에 포함하지 않았습니다. `DataProvider.load()` 인터페이스에 메서드를 추가하는 방식으로 확장할 수 있습니다.

## 6. 작업 계획과 진행 상황

| Phase | 내용 | 상태 |
| --- | --- | --- |
| 1 Core MVP | 프로젝트 초기화, 타입, Provider, exact/partial, 인덱스, 필드 선택, search/reload, 테스트 | 완료 |
| 2 LayerCache | API 분석, 어댑터, 기본 메모리 캐시, CacheStack 주입, 무효화/동시성, 캐시 비활성화 | 완료 (실제 layercache 5.0.0 통합 테스트) |
| 3 Advanced | 퍼지, 관련도 점수, 가중치, 정렬, 벤치마크, 한국어/유니코드 | 완료 |
| 4 Release | README, 예제, CI, 타입/빌드 검사, npm pack 테스트, 배포 워크플로 초안 | 완료 (npm 배포는 승인 후) |

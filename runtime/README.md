# 영속 기억 관리 코어

Node.js 22.13 이상에서 별도 실행 의존성 없이 SQLite로 동작한다. 원자료 추출·모델 호출·인증 서버를 포함하지 않는다. 사람이나 에이전트가 의미와 근거를 읽고 만든 변경안을 같은 저장 거래로 반영한다.

```js
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from './store.mjs';
import { prepareEvolution } from './evolution.mjs';

const db = new DatabaseSync('memory.sqlite');
const store = new MemoryStore(db);
store.install();
const plan = prepareEvolution(store, {
  request_id: 'unique-request-id',
  actor: 'authenticated-reviewer',
  reason: '새 경험의 조건과 기존 판단을 비교했다',
  recorded_at: new Date().toISOString(),
  memories: [], links: [], units: [], sources: []
});
// 실제 의미 변경이 담긴 비어 있지 않은 계획만 store.apply(plan)으로 반영한다.
```

## 책임과 계약

- `install`: memory_* 테이블을 추가한다. 기존 DB의 다른 테이블과 user_version은 변경하지 않는다. 조회에서 자동으로 설치하지 않는다.
- `prepareEvolution`: 명시적인 의미·조건·관계·원문 구간 판단을 버전 검증이 있는 변경안으로 만든다. 자연어를 자동 추출하거나 자동 채택하지 않는다.
- `apply`: 읽은 대상과 의존 집합의 토큰을 확인하고 본문·관계·구간·영향 상태·결과를 원자적으로 저장한다. 무관한 기억의 변경은 충돌 원인이 아니다.
- `receipt`: 요청 결과를 읽는다. 재시작·시간초과 뒤 무조건 변경을 재실행하지 않는다.
- `inspect`·`history`: 현재 기억, 근거와 이전 변경의 원인을 읽는다. 검토가 최신인지 함께 표시한다.
- `recall`: 문자 검색으로 찾은 기억에서 관계를 따라 전제·반례·근거를 읽고 질문에 따른 그래프 활성도로 정렬한다. 활성도는 질문 관련성이며 믿음의 참일 확률이 아니다.
- `evidence`: 같은 적용 조건의 독립 사건 집단과 충돌을 집계한다. 사용량과 지지 수를 합치지 않는다.

[영속 변경 스키마](../schema/runtime-change.schema.json)는 코드가 실제 검증하는 계약이다. 메모리 내 참조 전이의 전체 revision 계약과 혼용하지 않는다. 변경 계약은 request_id·actor·reason·recorded_at·expect·operations다. expect는 실제 읽은 기억/관계/원자료 ID→검증 토큰 또는 새 ID의 null이다. 원문 구간 변경에는 expect_units도 필요하다. put의 type은 input/memory/link이며 record는 모델 스키마를 따른다. annotate_input, withdraw_input, review, unit, use, invalidate도 지원한다.

원문 본문과 해시는 불변이다. 나중에 확인한 경험 시점·동일 사건 집단은 annotate_input으로 원인을 남겨 정정하며 관련 기억을 재검토한다. 본문 정정은 새 원문 버전과 기존 근거의 명시적인 갱신으로 처리한다. 기억의 의미·조건이 바뀌면 버전이 올라간다. 새 관계와 관계 철회는 의존 집합의 토큰도 바꾼다. 미검토 전제에 기대고 검토를 확정할 수 없으며 순환 전제는 집합을 함께 검토한다.

`validateChange`는 같은 쓰기 거래 안에서 실행되는 적용 환경의 사전조건 확인 함수다. 외부 문서 버전이나 권한 같은 정책을 검증할 때 사용한다. 실제 사용자의 인증과 채택 권한은 적용 환경이 관리해야 한다. actor 문자열만으로 권한이 생기지 않는다.

## 버전과 검증 한계

영속 코어의 검토 토큰 프로파일은 `memory-store/1`이다. 불변 원문의 본문 대신 검증한 SHA-256과 출처 메타데이터를 포함한다. 원문을 읽을 때 해시를 확인한다. 기존 메모리 내 0.1 참조 프로파일과 토큰을 혼용하지 않는다. 모델의 기본 기록 필드는 공유하지만 독립 구현 간 전체 상태 교환은 추가 적합성 관문이다.

공개 테스트는 서로 다른 DB 연결의 동시 수정, 거래 롤백, 재시작 후 요청 결과, 의미·조건 변화, 근거 철회, 중복·충돌 집계, 간접 영향, 순환 검토, 사용량 구분, 외부 버전 사전조건을 확인한다. 실제 자료의 의미 분석과 조직의 방향 채택을 검사기가 자동으로 대신하지 않는다.

```bash
node --test runtime/*.test.mjs
```

`afterChange`는 코어 변경과 같은 거래에서 어댑터의 등록 상태를 반영한다. 실패하면 코어 기록·변경 결과·어댑터 상태 모두 취소된다. 원문 구간을 여러 개 처리할 때는 같은 불변 원문을 그 거래에서 한 번 검증하며 구간마다 전체 원문을 다시 읽지 않는다.

합성 영속 예제는 `node examples/persistent-demo.mjs`로 실행한다. 같은 경험의 재인용, 새로운 반례, 의미의 조건 추가, 의존 절차의 검토 만료, 재시작 후 변경 결과와 원본 보존을 보여주고 임시 DB는 제거한다.

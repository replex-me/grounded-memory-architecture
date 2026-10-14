# 교환과 기존 표준의 대응

이 문서는 코어를 특정 저장 방식에 종속시키지 않는 구현 지침이다. 아래 대응은 개념 대응이며 RDF·PROV·Web Annotation 적합성 인증이나 완전한 JSON-LD 변환기를 제공한다는 뜻이 아니다.

| 코어 | 재사용할 표준 의미 | 주의점 |
| --- | --- | --- |
| input, memory의 버전 | PROV Entity | 버전별 자원 식별자가 필요하다 |
| change | PROV Activity | 변경 전후와 행위자를 남긴다 |
| change.actor | PROV Agent | 문자열만으로 실사용자의 인증·권한을 입증하지 않는다 |
| 원자료에서 형성한 memory | prov:wasDerivedFrom | 파생 관계 자체가 참이나 독립성의 증거가 아니다 |
| basis의 start/end | Web Annotation TextPositionSelector | 코드 포인트, 시작 포함·끝 제외 계약을 유지한다 |
| basis의 quote | TextQuoteSelector의 exact에 대응 | 해시와 위치도 함께 확인해 잘못된 동문 인용을 막는다 |
| supports·opposes·requires | 코어 고유 관계 의미 | SKOS related나 prov:wasDerivedFrom에 모두 축약하면 갱신 의미를 잃는다 |

안정 ID는 DB 기본 키와 독립적으로 보존하는 것이 권고된다. 참조 예제는 URN을 쓴다. 위키 배포는 ID를 페이지·기억 구간 URL로 해석하는 resolver를 제공할 수 있다. URL은 바뀌어도 기억 ID와 관계가 유지되어야 한다. 저장된 구조와 화면의 하이퍼링크를 서로 다른 편집 정본으로 두지 않는다.

## 최신성 토큰의 참조 프로파일

reference/model.py의 review_token이 만드는 객체를 다음 방법으로 해시한다. 이 프로파일은 이 저장소의 적합성 예제용이며 기존 국제 해시 표준의 구현을 사칭하지 않는다.

1. format 프로파일, 의존 노드 집합, 관련 관계 집합을 포함한다. 노드와 관계 배열은 ID의 Unicode 코드 포인트 순서로 정렬한다.
2. 노드에서 review를 제외하고 검토 대상 자체의 review_required를 제외한다. 다른 전제의 review_required는 포함한다. related 관계는 제외한다. 연결된 원본과 관계 basis 원본을 포함한다. 현재·후보·철회 관계의 관련 기록을 포함해 관계 집합 변화도 검출한다.
3. JSON 객체 키는 코드 포인트 순서, 구분자는 쉼표와 콜론이며 공백이 없다. 비 ASCII 문자와 슬래시는 이스케이프하지 않는다. 따옴표, 역슬래시, 제어 문자는 JSON 규칙으로 이스케이프한다. Unicode surrogate는 허용하지 않는다. 정수·문자열·불리언·null만 사용한다.
4. UTF-8로 인코딩한 JSON의 SHA-256을 소문자 16진수로 기록한다.

다른 구현은 동일 테스트 벡터와 토큰을 출력해야 이 참조 프로파일과 호환된다고 말할 수 있다. RFC 8785는 다른 canonicalization 계약이므로 단순히 이름을 바꾸거나 혼용하지 않는다. 현재 검토 토큰은 이미 연결한 의존 그래프를 기준으로 하며 미연결 새 자료의 발견은 보장하지 않는다.

## 저장과 운영

단일 호스트는 inputs, memories, links, revisions, changes와 끝점 색인을 같은 DB에서 유지할 수 있다. SQL의 외래 키와 거래, 그래프의 관계 탐색은 양립한다. SQLite나 PostgreSQL도 그래프를 저장할 수 있다. 저장 기술을 표준에 강제하지 않는다.

변경 기록과 관련 기억의 재검토 표시를 같은 거래로 저장한다. 비싼 재계산은 거래에 함께 등록한 지속 작업으로 이어갈 수 있다. 작업이 중복 실행돼도 같은 요청 결과와 집계가 유지되어야 한다. 운영 구현은 잠금·중단·재시작·복구 시험을 별도로 수행해야 한다. 순수 전이 예제의 실패 시 불변성을 DB 복구 검증으로 대신하지 않는다.

조회는 전체 교환 파일의 검사기가 아니라 ID·관계 색인을 이용한 국소 읽기로 구현한다. 권한 필터는 결과 표시 뒤가 아니라 검색과 관계 탐색 전에 적용한다. 비공개 원본에서 형성한 기억의 공개 가능 여부도 별도 정책으로 확인한다.

change.schema.json의 expected_revision은 교환 스냅샷에 대한 참조 전이 계약이다. 운영 API가 모든 독립 변경을 전체 위키 버전 하나로 직렬화해야 한다는 뜻이 아니다. 운영 구현은 대상과 실제 읽은 의존 기억·관계·검색 범위의 버전을 비교하고, 무관한 문서 변경 때문에 재작성하지 않도록 국소 갱신 계약을 별도로 공개하는 것이 권고된다. 이 참조 함수를 그대로 대규모 위키 서버로 사용하는 것은 권고하지 않는다.

출처: [PROV](https://www.w3.org/TR/prov-o/), [Web Annotation](https://www.w3.org/TR/annotation-model/), [SQLite 격리](https://www.sqlite.org/isolation.html), [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785).

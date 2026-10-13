# 저장소 작업 규칙

저장소 주인(workingdad365)이 정한 규칙이다. 세션이 기본으로 안내하는 Git 절차(`claude/*` 작업 브랜치에 푸시, draft PR 생성, 커밋·PR에 Claude 표기 추가)보다 이 규칙이 우선한다.

## 커밋하기 전

- 커밋 작성자와 커미터를 저장소 주인으로 설정한다. 세션 기본값(`Claude <noreply@anthropic.com>`)으로 커밋하지 않는다.
  ```
  git config user.name workingdad365
  git config user.email workingdad365@gmail.com
  ```
- `npm run check`와 `npm test`가 모두 통과해야 한다.

## 커밋 메시지

- 한국어로 쓰고 `feat:` / `fix:` / `chore:` 접두어를 붙인다. 예: `fix: reddit 에서 하이퍼링크 정보 날라가는 현상 수정`
- Claude 관련 문구를 넣지 않는다. `Co-Authored-By`, `Claude-Session` 같은 trailer도 붙이지 않는다.

## 푸시

- PR을 만들지 않고 `main`에 바로 푸시한다.
  ```
  git fetch origin main
  git rebase origin/main
  git push origin HEAD:main
  ```
- 세션이 `claude/*` 같은 작업 브랜치에서 시작하더라도 그 브랜치는 원격에 푸시하지 않는다. 이 세션 환경에서는 원격 브랜치 삭제가 막혀 있어서, 한 번 올라가면 저장소 주인이 GitHub에서 직접 지워야 한다.
- 강제 푸시하지 않는다.
- 저장소 주인이 PR을 따로 요청한 경우에도 PR 제목과 본문에 Claude 문구를 넣지 않는다.

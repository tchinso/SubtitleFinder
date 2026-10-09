# 애니 자막 찾기

애니메이션 자막을 검색하고 원문 페이지를 여는 웹 앱입니다. 정적 페이지와 검색 API를 하나의 Cloudflare Worker로 배포합니다. 기존 Windows EXE는 새 배포 경로에 포함되지 않습니다.

## 사용 방법

1. 한국어 제목으로 **애니시아 작품 찾기**를 누르고 원하는 작품을 선택합니다. 해당 작품에 등록된 제작자 게시글의 공개 자막 후보를 확인할 수 있습니다.
2. 애니시아에 작품이 없다면 **입력 제목으로 자막 찾기**를 누릅니다. 이미 알고 있는 게시글 주소는 **링크 확인**에 붙여넣을 수 있습니다.
3. 영문 또는 로마자 제목으로 **Bigfile 검색**을 누르거나 **Jimaku 검색**을 새 탭에서 엽니다. Bigfile 파일은 사이트 로그인 후 직접 내려받습니다. Jimaku는 영문 제목으로 검색할 수 있지만 주로 **일본어 자막**을 제공합니다.
4. **OpenSubtitles**는 API 키 없이 `opensubtitles.org` 검색 페이지를 새 탭에서 엽니다. 언어를 선택하고 사이트가 요구하는 브라우저 검증이나 로그인을 직접 완료합니다. 이 앱은 검증을 우회하거나 OpenSubtitles 페이지를 대신 가져오지 않습니다.
5. 후보의 **파일 열기** 또는 **원문 열기**를 눌러 출처 사이트에서 자막을 확인합니다. 영문·로마자 제목에는 `subtitle download`를 붙여 Google 미국 검색(`gl=US`, `num=100`, `newwindow=1`)을 새 탭에서 열 수도 있습니다.

브라우저의 보안 제한 때문에 다른 사이트의 로그인·봇 검증 결과를 Worker에 전달하거나, 모든 출처의 파일을 앱에서 일괄 다운로드할 수는 없습니다. 공개 첨부는 가능한 경우 파일 링크로 표시하고, 원본 ZIP/7z/RAR 선택과 시즌 폴더 저장은 출처 사이트나 사용자의 브라우저에서 처리합니다.

## 로컬 실행

Node.js 22 이상과 pnpm 11 이상이 필요합니다.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Wrangler가 출력하는 로컬 주소를 브라우저에서 엽니다. `pnpm test:web`으로 Worker 검색 경로의 모의 응답 테스트를 실행할 수 있습니다. 기존 Python 코드의 회귀 테스트는 `python -m unittest discover -s tests -v`입니다.

## Cloudflare Worker 배포

Cloudflare 계정으로 Wrangler에 로그인한 다음 배포합니다.

```sh
pnpm exec wrangler login
pnpm deploy
```

`wrangler.jsonc`가 `web/`의 정적 파일과 `worker/`의 `/api/*` 검색 API를 함께 배포합니다. Jimaku와 OpenSubtitles 검색에는 API 키를 사용하지 않고 사용자의 브라우저에서 각 사이트의 검색 결과를 엽니다.

## 구성

| 경로 | 역할 |
| --- | --- |
| `web/` | 브라우저 화면과 검색 조작 |
| `worker/` | 애니시아·Bigfile 검색 API와 직접 검색 링크 |
| `wrangler.jsonc` | Cloudflare Worker와 정적 파일 배포 설정 |
| `subfinder/`, `run.py` | 이전 Python/Tkinter 구현 및 동작 참고용 코드 |

웹 앱은 임의 URL을 프록시하지 않습니다. 수동 링크 확인은 지원 출처의 공개 페이지나 첨부 주소로 제한합니다. 작품과 자막의 일치 여부는 파일명·회차·제작자·원문을 확인해 판단해 주세요.

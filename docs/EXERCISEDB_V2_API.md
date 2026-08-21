# ExerciseDB V2 — guia para o Cursor (London Fitness)

Documento para o Cursor do **Expo** e do **backend**. A fonte oficial da OpenAPI é [v2.exercisedb.dev/docs](https://v2.exercisedb.dev/docs) e [docs.ascendapi.com](https://docs.ascendapi.com/products/edb-v2/overview). Este arquivo define **como o nosso app usa** essa API.

## Arquitetura obrigatória

```text
USUÁRIO
  → APP EXPO
    → BACKEND LONDON FITNESS  (/api/media/*, /api/exercises, /api/plans, …)
      → SQLite (cache 7 dias) / Postgres (catálogo London)
        → ExerciseDB V2 (RapidAPI)  ← só o back, e só em cache miss
```

**Proibido no Expo:** `X-RapidAPI-Key`, host `*.p.rapidapi.com`, `oss.exercisedb.dev`, `v2.exercisedb.dev`. A key fica no `.env` do back (`RAPIDAPI_KEY`).

`exerciseId` das fichas/planos/sessões é **London** (`hip-thrust-barra`). O id da V2 (`exr_41n2h…`) só existe na mídia cacheada. Não misturar.

## Cota (plano Basic — o que estamos usando)

Fonte: [Pricing RapidAPI — EDB with Videos and Images](https://rapidapi.com/ascendapi/api/edb-with-videos-and-images-by-ascendapi/pricing)

| Item | Basic ($0) |
|---|---|
| Requests | **2.000 / mês** (hard limit) |
| Rate | 1000 / hora |
| Library no plano free | 200 exercícios (mídia com marca d’água `/media/w/`) |
| Caching | permitido |
| Cartão | não exigido no Basic |

Não é o “500 mil/mês” genérico da RapidAPI. Estourar o mês = API morta até o reset.

**Não** sincronizar os 11 mil exercícios. Cada listagem pagina `limit` máx. 25; um dump custaria centenas de calls. Persistimos só o que o aluno abre + 4 taxonomias.

## O que persistimos (SQLite `data/app.sqlite`)

Nunca blob de GIF/MP4. Só texto e URL.

| Tabela | Conteúdo | TTL | Tamanho |
|---|---|---|---|
| `v2_taxonomies` | muscles, bodyparts, equipments, exercisetypes | 7 dias | ~dezenas de KB |
| `v2_exercises` | 1 linha por `exr_…`: name, 1 `image_url`, 1 `video_url`, músculos, overview, instructions, tips, variations | 7 dias | ~2–4 KB/linha |
| `media_v2` | resposta já montada por `q+gender` | 7 dias | pequeno |

Não gravamos `keywords` (SEO) nem as 4 resoluções de `imageUrls`.

Fluxo: 1ª abertura de “hip thrust” = 1–2 calls V2. Depois 7 dias = 0 calls.

## Rotas do NOSSO back (o Expo só usa estas)

Base: `API_URL` do app. Sem RapidAPI.

| Método | Rota | Quando usar |
|---|---|---|
| GET | `/api/media/exercise?q=hip%20thrust&gender=mulher` | Tela do exercício: foto, vídeo, instruções |
| GET | `/api/media/exercise?exerciseId=exr_…` | Já temos o id V2 |
| GET | `/api/media/muscles` | Filtro / labels de músculo V2 |
| GET | `/api/media/bodyparts` | Filtro parte do corpo |
| GET | `/api/media/equipments` | Filtro equipamento |
| GET | `/api/media/exercisetypes` | Filtro tipo (strength, …) |
| GET | `/api/media/fallback?q=` | GIF Tenor se V2 falhar |
| GET | `/api/exercises?search=` | Catálogo V1 local (GIF 180p). IDs **não** são London |
| GET | `/api/exercises/:id?gender=mulher` | Detalhe V1 + tenta enriquecer V2 |
| GET | `/api/plans/active` | Plano da semana (IDs London) |
| POST | `/api/plans/generate` | IA; `gender` = `homem` \| `mulher` |

`q` em `/api/media/exercise` é nome **inglês** (`bench press`, `hip thrust`), não `supino-reto-barra`.

### Exemplo Expo (TypeScript)

```ts
const API = process.env.EXPO_PUBLIC_API_URL; // nosso back

export async function loadExerciseMedia(q: string, gender: "homem" | "mulher") {
  const url = `${API}/api/media/exercise?q=${encodeURIComponent(q)}&gender=${gender}`;
  const res = await fetch(url);
  return res.json() as Promise<{
    success: boolean;
    cached?: boolean;
    fromCache?: boolean;
    exerciseId?: string;
    name?: string;
    imageUrl?: string | null;
    videoUrl?: string | null;
    gifUrl?: string | null;
    overview?: string | null;
    instructions?: string[];
    exerciseTips?: string[];
    variations?: string[];
    targetMuscles?: string[];
    genderMatched?: boolean;
    error?: string;
  }>;
}
```

**201/200 generate** e **IDs London** continuam o contrato de treino. Mídia V2 é anexo visual.

Erros V2 no back: `503 exercisedb_v2_unsubscribed` · `429 exercisedb_v2_rate_limited` · `502 exercisedb_v2_unavailable`. Front cai no `gifUrl` / fallback.

---

## Spec ExerciseDB V2 (só o backend chama)

Host RapidAPI: `edb-with-videos-and-images-by-ascendapi.p.rapidapi.com`  
Base: `https://edb-with-videos-and-images-by-ascendapi.p.rapidapi.com/api/v1`  
Headers: `X-RapidAPI-Key`, `X-RapidAPI-Host` (sem JWT da London).

`/w/` na CDN = watermark do Basic, **não** significa woman. Campo `gender` **não vem** no JSON atual (GitHub às vezes mostra; a API live não). `maleMuscleActivationUrl` / `femaleMuscleActivationUrl` = “next update”.

### Endpoints

| Método | Path | Uso no nosso back |
|---|---|---|
| GET | `/liveness` | não expor |
| GET | `/exercises` | busca por `name` no cache miss (limit 10) |
| GET | `/exercises/search?search=` | fuzzy; ainda não usamos (economiza cota) |
| GET | `/exercises/{exerciseId}` | detalhe → upsert `v2_exercises` |
| GET | `/muscles` | cache `v2_taxonomies` |
| GET | `/bodyparts` | idem |
| GET | `/equipments` | idem |
| GET | `/exercisetypes` | idem |

### GET `/exercises` — filtros

Query: `name`, `keywords`, `targetMuscles`, `secondaryMuscles`, `exerciseType`, `bodyParts`, `equipments`, `limit` (1–25, default 10), `after`, `before`.

Paginação **cursor** (`nextCursor` / `hasNextPage`). Não usar offset.

Listagem **não** traz overview, tips, variations, videoUrl completo. Detalhe sim.

Exemplo (back):

```http
GET /api/v1/exercises?name=Hip%20Thrust&limit=10
GET /api/v1/exercises?bodyParts=Chest&equipments=Barbell&limit=10
GET /api/v1/exercises?targetMuscles=Gluteus%20Maximus&exerciseType=strength
GET /api/v1/exercises/search?search=bench
GET /api/v1/exercises/exr_41n2hxnFMotsXTj3
```

`targetMuscles=Chest` costuma ser errado: músculo é `PECTORALIS MAJOR STERNAL HEAD`; parte do corpo é `Chest` em `bodyParts`.

### Listagem (resumo)

`exerciseId`, `name`, `equipments[]`, `bodyParts[]`, `exerciseType`, `targetMuscles[]`, `secondaryMuscles[]`, `imageUrl`, `keywords[]` (não persistimos keywords).

### Detalhe (completo)

Tudo da listagem + `overview`, `instructions[]`, `exerciseTips[]`, `variations[]`, `relatedExerciseIds[]`, `videoUrl`, `imageUrls.{360p,480p,720p,1080p}`. Persistimos **uma** imageUrl + videoUrl.

### Taxonomias

Cada item: `{ "name": "GLUTEUS MAXIMUS", "imageUrl": "..."? }`. Músculos que já vimos: ADDUCTOR *, BICEPS BRACHII, DELTOID *, GLUTEUS *, HAMSTRINGS, QUADRICEPS, PECTORALIS MAJOR *, TRICEPS BRACHII, LATISSIMUS DORSI, …

### Erros RapidAPI

401/403 key ou não inscrito · 429 cota · 404 id.

## Regras para o Cursor

**Expo**

1. Treino = IDs London + `/api/plans` + `/api/sessions/complete`.
2. Visual = `/api/media/exercise` com `q` inglês + `gender` do perfil mapeado (`female` → `mulher`).
3. Preferir `videoUrl`, senão `imageUrl`, senão GIF V1/fallback.
4. Não assumir personagem feminino no GIF. `genderMatched` hoje costuma ser `false`.
5. Não montar catálogo de 11k no client.

**Backend**

1. Sempre SQLite antes da RapidAPI.
2. TTL 7 dias. `limit` ≤ 10 na busca.
3. Proibido job que pagina os 11k no plano Basic (2k calls/mês).
4. Postgres = London + conta/treino. SQLite = ExerciseDB/V2 cache.
5. Logs JSON; não logar `RAPIDAPI_KEY`.

## Mapa mental

```text
ExerciseDB V2
├── Exercícios (listar / filtrar / search / id)  → cache v2_exercises
├── Classificação (músculos, bodyparts, equipamentos, tipos) → v2_taxonomies
└── Detalhe (texto + URL de imagem/vídeo) → tela do exercício via /api/media/exercise
```

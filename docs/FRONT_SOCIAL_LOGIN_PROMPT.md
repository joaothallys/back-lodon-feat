# Prompt para o front — Google e Apple Sign-In (London Fitness)

Copie e cole este prompt no Cursor / para o dev do app. O backend **já está pronto**.

---

Você vai implementar Google Sign-In e Apple Sign-In na tela de login do app London Fitness (Expo + React Native).

O backend já tem rotas dedicadas. **Não copie o fluxo do PoliApp.** Lá o Apple ia no campo `google_token` para `POST /login` e **não funciona**. Aqui cada provedor tem endpoint próprio e o back valida o token de verdade.

## Contrato da API

Base URL: a mesma do app (`EXPO_PUBLIC_API_BASE_URL`). Local: `http://127.0.0.1:3000`.

Sessão: `accessToken` JWT (~15 min) + `refreshToken` (~30 dias). Guardar os dois. Em toda rota privada: `Authorization: Bearer <accessToken>`. Quando o access expirar, `POST /api/auth/refresh` e rotacionar o refresh.

Resposta padrão de login/cadastro social:

```json
{
  "success": true,
  "created": false,
  "message": "Já existe uma conta com este e-mail",
  "accessToken": "jwt",
  "refreshToken": "hex",
  "tokenType": "Bearer",
  "expiresIn": 900,
  "sessionId": "uuid",
  "data": {
    "id": "uuid",
    "email": "ana@gmail.com",
    "role": "aluno",
    "status": "active",
    "onboardingDone": false,
    "googleLinked": true,
    "appleLinked": false,
    "profile": { "name": "Ana Souza" }
  }
}
```

O e-mail da conta **sempre** vem do token validado (Google/Apple), não do que o app digitar.

- `201` + `created: true` + `message: "Conta criada"` → primeira vez. Entrar e seguir o onboarding se `onboardingDone === false`.
- `200` + `created: false` + `message: "Já existe uma conta com este e-mail"` → **não cria de novo**. Vincula o provedor se ainda não estava e já devolve tokens. Mostrar toast “Você já tem uma conta. Entrando…” e ir pra home/onboarding. **Não** mostrar tela de cadastro de novo.
- `409` em `POST /api/auth/register` se o e-mail já existir: `"e-mail já cadastrado. Entre com o Google"` (ou Apple / “Faça login”). Não criar outra conta.

Depois do login, pode chamar `GET /api/auth/me` para hidratar o usuário.

### Google — `POST /api/auth/google`

```json
{
  "idToken": "eyJhbGciOiJSUzI1NiIs...",
  "accessToken": "ya29.a0...",
  "name": "Ana Souza",
  "device": "ios"
}
```

- Prefira `idToken` (JWT). Também aceita `accessToken` ou `google_token`.
- Envie os dois se tiver. `name` só é usado no primeiro cadastro.
- `device`: `"ios"` | `"android"` | `"web"`.

### Apple — `POST /api/auth/apple`

```json
{
  "identityToken": "eyJhbGciOiJSUzI1NiIs...",
  "nonce": "<nonce cru, NÃO o hash>",
  "name": "Ana Souza",
  "email": "ana@privaterelay.appleid.com",
  "device": "ios"
}
```

- `identityToken` é obrigatório (JWT da Apple).
- Mande o **nonce cru** (o mesmo que você hasheou antes de passar para a Apple). O back confere o hash.
- `name` e `email` só vêm no **primeiro** login iOS. Guarde o nome localmente se precisar; no 2º login a Apple não devolve.
- **Nunca** use fallback `apple_user@privaterelay.appleid.com`. Se não tiver email, omita o campo. O back identifica pelo `sub` da Apple.
- Apple só no iOS. No Android esconda o botão.

### Email/senha (já existe)

- `POST /api/auth/login` `{ email, password, device }`
- `POST /api/auth/register` `{ email, password, name, device }`
- Conta só-social tentando senha: `401` `"esta conta usa login social"`.

### Erros para a UI

| Status | error | UI |
|--------|--------|-----|
| 400 | `idToken ou accessToken é obrigatório` / `identityToken é obrigatório` | Bug de integração |
| 401 | `token Google/Apple inválido` / `nonce inválido` | "Não foi possível validar o login. Tente de novo." |
| 403 | `usuário deletado. Restaure a conta...` | Conta excluída |
| 409 | conta social já vinculada a outro usuário | Conflito de e-mail |
| 503 | `login Google/Apple não configurado` | Env do back. Avisar o back. |
| cancelado no SDK | — | Não mostrar erro grave. |

## Credenciais Google (mesmo projeto do Poli)

Usar estes Client IDs:

```
Android: 1053297902526-tvi162hl38lg33fltjt2ousvlaulof2a.apps.googleusercontent.com
iOS:     1053297902526-k4ugspt500kb8re2u2jok3d2dv57v37h.apps.googleusercontent.com
Web:     1053297902526-qenpb3q0jnc07e1jj4494nb4hftgisal.apps.googleusercontent.com
```

Redirect URIs do Poli (só funcionam se o bundle/package for o mesmo):

- iOS: `com.googleusercontent.apps.1053297902526-k4ugspt500kb8re2u2jok3d2dv57v37h:/oauth2redirect`
- Android: `com.developer_jr.poliApp:/oauth2redirect/google`

**Atenção:** esses clients estão amarrados ao package/bundle do Poli (`com.developer_jr.poliApp` / `com.developer-jr.poliApp`). Se o app London tiver bundle diferente, o Google recusa o redirect. Aí criar OAuth clients novos no Google Cloud (Android + iOS + Web) para o bundle/package/SHA-1 do London e mandar os IDs novos para o back atualizar `GOOGLE_CLIENT_IDS`.

Apple: `APPLE_CLIENT_IDS` no back hoje é `com.developer-jr.poliApp`. O `aud` do `identityToken` tem que ser o `ios.bundleIdentifier` do **nosso** app. Quando o `app.json` do London existir, avisar o back para trocar.

## Passo a passo de implementação

1. **Dependências**
   - `expo-auth-session`
   - `expo-web-browser`
   - `expo-crypto`
   - `expo-apple-authentication`
   - `expo-secure-store` (ou AsyncStorage, preferir SecureStore para tokens)

2. **`app.json` / `app.config`**
   - Plugin `expo-web-browser`
   - Plugin `expo-apple-authentication`
   - iOS: `"usesAppleSignIn": true`
   - Scheme iOS Google: reversed client id `com.googleusercontent.apps.1053297902526-k4ugspt500kb8re2u2jok3d2dv57v37h` (se usar o client iOS acima)
   - Capability Sign in with Apple no Xcode / EAS

3. **Tela de login**
   - Manter email + senha.
   - Botão **Continuar com Google** no **iPhone, Android e web**. No iOS o Google é obrigatório — não esconder porque existe Apple. Os dois botões ficam juntos no iPhone.
   - Botão **Continuar com Apple** só se `Platform.OS === 'ios'` e `AppleAuthentication.isAvailableAsync()`. No Android, esconder Apple.
   - Loading independente por botão. Não travar a tela inteira.
   - Depois do sucesso: se `data.onboardingDone === false`, ir para onboarding; senão home.

4. **Google (iPhone e Android)**
   - O back `POST /api/auth/google` **não filtra plataforma**. `device: "ios"` é só metadado da sessão.
   - No iPhone usar o **Client ID iOS** (`…k4ugspt500kb8re2u2jok3d2dv57v37h…`) e o scheme reversed:
     `com.googleusercontent.apps.1053297902526-k4ugspt500kb8re2u2jok3d2dv57v37h:/oauth2redirect`
   - `AuthSession.useAutoDiscovery('https://accounts.google.com')`
   - `responseType: Code`, `usePKCE: true`, scopes `openid profile email`
   - `Platform.select`: iOS → client iOS, Android → client Android, default → Web
   - Trocar o `code` por tokens no token endpoint do discovery
   - Chamar `POST /api/auth/google` com `idToken` + `accessToken` + `name` (se tiver) + `device`
   - **Não** chamar userinfo no client para autenticar. O back valida.
   - **Não** mandar `password: google_oauth_...` nem bater em `/api/auth/login`.

5. **Apple (iOS)**
   ```ts
   const nonce = Math.random().toString(36).slice(2);
   const hashedNonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, nonce);
   const credential = await AppleAuthentication.signInAsync({
     requestedScopes: [
       AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
       AppleAuthentication.AppleAuthenticationScope.EMAIL,
     ],
     nonce: hashedNonce,
   });
   ```
   - POST `/api/auth/apple` com:
     - `identityToken: credential.identityToken`
     - `nonce` **cru** (não o hash)
     - `name` montado de `credential.fullName` se existir
     - `email: credential.email` só se vier (nunca inventar)
     - `device: "ios"`
   - **Não** enviar Apple no campo `google_token`.
   - **Não** POST `/api/auth/login`.

6. **Sessão**
   - Salvar `accessToken`, `refreshToken`, `user` (`data`).
   - Interceptor HTTP: se 401, tenta `POST /api/auth/refresh` `{ refreshToken, device }`; se ok, grava os novos tokens e repete o request; se falhar, logout.
   - Logout: `POST /api/auth/logout` `{ refreshToken }` e limpar storage.

7. **O que não fazer (erros do PoliApp)**
   - Não reutilizar `POST /login` para social.
   - Não mandar Apple como `google_token`.
   - Não inventar senha `google_oauth_{id}`.
   - Não usar email dummy `apple_user@privaterelay.appleid.com`.
   - Não achar que o Google access token é o JWT da sessão. A sessão é o `accessToken` **nosso**.

## Checklist de aceite

- [ ] **iPhone: botão Google visível** e login completa (Safari/ASWebAuthenticationSession → volta pro app)
- [ ] Google no Android cria conta nova (201) e entra
- [ ] Google de novo no mesmo e-mail (iOS ou Android) entra (200) e `googleLinked: true`
- [ ] Google com e-mail já cadastrado por senha vincula e entra
- [ ] Apple no iOS cria / entra; 2º login sem email ainda funciona
- [ ] Apple escondido no Android; Google **não** escondido no iPhone
- [ ] Cancelar o sheet não mostra erro de servidor
- [ ] Token Google/Apple inválido mostra mensagem amigável
- [ ] Access expira e o refresh renova sem deslogar
- [ ] Email/senha continua funcionando
- [ ] Conta só-social não loga com senha inventada

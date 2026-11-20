# Email password setup and email-code login

Related: [#262](https://github.com/openTeamily/openTeamily/issues/262), [#1](https://github.com/openTeamily/openTeamily/issues/1).

Email has two separate jobs and they must not be mixed:

- **Registration / account setup** sends a single-use **set-password link**.
  The user chooses a password, then signs in with email/username + password.
- **Email login** sends a six-digit code only for an account whose email is
  already linked. It never creates an account and never sends a password link.

Existing accounts created by OIDC/GitHub can use the setup link to establish a
password; the account id, workspaces and data stay the same.

## Routes

All POSTs require exact Origin. Responses are `no-store`; no route reveals
whether an email has an account, except the normal password-login error.

| Method | Path | Body | Behavior |
|---|---|---|---|
| POST | `/v1/auth/password/request` | `{email, accept_terms:true}` | Sends a set-password link for a new or existing email. Always returns a generic `{ok:true, expires_in}` on accepted mail; rate limited per email/IP. |
| POST | `/v1/auth/password/complete` | `{token, password}` | Consumes the single-use link, sets the password, marks the email verified, accepts terms, creates the account for a new email, and returns a session. Existing users keep their account id. |
| POST | `/v1/auth/email/login/start` | `{email}` | Sends a six-digit login code **only if the email is linked to an account**. The response is generic; no account is created. |
| POST | `/v1/auth/email/login/verify` | `{email, code}` | Consumes a valid login code and returns a session. Unknown emails/invalid codes use the same error. |
| POST | `/v1/auth/login` | `{username, password}` | `username` may be a username or a linked email. Registration still uses the username/password route. |

## Bounds and security

- Password: 12–256 characters, at most 256 UTF-8 bytes.
- Set-password token: 43 URL-safe characters, SHA-256/HMAC digest stored only,
  30-minute default lifetime, single use; one active token per email.
- Login code: six digits, 10-minute default lifetime, at most five attempts,
  hashed with the deployment wrapping key.
- Resend window 60 seconds; five emails per address/hour and twenty per IP/hour
  by default. Codes/tokens and SMTP credentials are never logged or returned.
- `email_codes`, `email_sends`, `password_setup_tokens` and `user_consents` are
  additive `CREATE TABLE IF NOT EXISTS`; `user_version` stays 1.
- The SMTP relay is operator-supplied. A failed send deletes the token/code and
  returns `503 mail_unavailable`; it never reports success without a send.

## UI

- `/register` has **邮箱注册 / 设置密码** (email + terms, sends the link) and
  **邮箱验证码登录** (email + code, existing accounts only), in addition to the
  direct username/password registration form.
- `/set-password?token=…` is the link landing page; it validates the token
  shape locally, confirms the password twice, posts once and opens the home.
- The shared login form accepts a username or a linked email as the identifier.
- `/v1/auth/policy` reports `email_registration` so the page can state whether
  the deployment enabled the email flows.

## Explicitly not in this slice

OAuth client authorization, MFA, password reset by security questions, email
change, disposable-address intelligence, bounce handling and a hosted mail
service. This is an independent OpenTeamily flow, not a commercial-product
parity or deliverability acceptance.

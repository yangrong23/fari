# fari — convite por e-mail para usuários pioneiros

Envia o e-mail de convite ("usuário pioneiro") para a sua lista de cadastros, usando a API da Resend. Zero dependências (Node 18+).

## Fluxo em 3 passos

### 1. Prepare a lista
Exporte sua planilha de e-mails para `data/invites.csv` no formato (veja `data/invites.csv.example`):

```
email,name
ana@email.com,Ana
bruno@email.com,Bruno
carol@email.com,
```

A coluna `name` é opcional. Linhas sem `@` válido (ex.: o cabeçalho) são ignoradas automaticamente.

Mantenha `data/suppressed.csv` com quem pediu para cancelar inscrição (um e-mail por linha).

### 2. Configure o remetente (Resend)
1. Crie conta em https://resend.com (grátis: 100 e-mails/dia, 3000/mês).
2. No painel da Resend, verifique o domínio `medrixai.com` (adiciona registros DKIM/SPF no DNS). Sem isso, só dá para testar com o remetente padrão `onboarding@resend.dev`.
3. Gere uma API key e exporte as variáveis:
   ```
   export RESEND_API_KEY=re_xxxxx
   export SITE_URL=https://o-seu-site.com   # URL pública do fari (link do botão)
   ```

### 3. Envie
Primeiro simule (não envia nada, só valida a lista e mostra os destinatários):
```
node scripts/send-invite.js
```

Depois, de verdade:
```
node scripts/send-invite.js --send
# para testar com poucos:
node scripts/send-invite.js --send --limit=5
```

O log da execução fica em `data/invite-log.json`.

## Editar o e-mail
Templates em `scripts/invite-email.html` e `scripts/invite-email.txt`.
Tokens: `{{NAME}}` (nome do destinatário) e `{{SITE_URL}}` (URL pública do site).

## Alternativa sem código (Brevo)
Se preferir interface gráfica em vez de script: crie conta no Brevo (https://brevo.com, 300/dia grátis), importe a planilha como contatos, crie uma automação "e-mail de boas-vindas", cole o conteúdo de `scripts/invite-email.html` e ative. Não precisa deste script.

## Observações legais
- LGPD/CAN-SPAM: envie só para quem se cadastrou. Mantenha `data/suppressed.csv` atualizado com quem pedir cancela.
- O rodapé do e-mail já traz endereço físico (exigido) e link de cancelar inscrição.
- `data/` está no `.gitignore` para os arquivos reais — nunca commitar e-mails reais.

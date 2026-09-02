# AGENTS.md — Convenções do projeto

Fork de NousResearch/hermes-agent, mantido por @julinhodailha. Python 3.13, deploy no Railway (gateway como processo principal).

## Regras de trabalho (não-negociáveis)

1. **Prove antes de dizer "pronto"** — nunca reporte uma tarefa como completa por intenção. Rode o teste, execute o script, curle o endpoint, leia de volta o registro criado. Capture a evidência real na resposta final (exit code, log, URL/ID). Use o skill `verify`.
2. **Planeje antes de mudança complexa** — para qualquer mudança com mais de ~1 arquivo ou que mexa em fluxo, escreva o plano primeiro (skill `plan`) e confirme a direção antes de codar.
3. **Grille antes de entregar** — revise o próprio diff de forma adversarial antes de commit/PR (skill `grill`): caça edge cases, erros de validação, vazamento de segredo, dead branches.
4. **Não quebre o gateway** — nunca edite `config.yaml` à mão (use `hermes config set`); segredos vão em `.env`, nunca em `config.yaml`; caminhos resolvem via `$HERMES_HOME`, nunca hardcode `~/.hermes`.

## Convenções

- **Commits**: Conventional Commits — `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`. Mensagem resume a intenção, não o arquivo.
- **Testes**: mudança de comportamento acompanha teste. Se não há como testar, diga explicitamente o que foi verificado e o que não foi.
- **Escopo**: mude só o que a tarefa pede. Cleanup mecânico no fim (skill `techdebt`), nunca refatoração de arquitetura "de passagem".
- **Idioma**: responda em pt-BR para o usuário.

## Compounding (regra do Boris)

> Toda vez que eu errar ou descobrir um gotcha deste projeto, ADICIONE aqui. Este arquivo é memória viva, não documentação estática.

<!-- Adicione abaixo as regras específicas do projeto conforme surgirem -->

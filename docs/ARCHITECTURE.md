# Arquitetura do Loounp

## Mapa do repositório

```text
src/
  core/                       Regras de domínio sem dependência do Electron
    content-discovery/        Conteúdo, perfil de interesses e URLs de feeds
    linkedin/                 Contratos de geração de posts
    personal-memory/          Ledger de memórias do usuário
    project-ideas/            Contratos e validação de ideias
    theme-research/           Contratos da pesquisa temática
  main/                       Processo principal e integrações do Electron
    discovery/                Fontes, ranking, agenda e arquivos do Medium
    linkedin/                 Serviço de geração e prompts
    project-context/          Armazenamento, leitura, recuperação e sandbox
    project-ideas/            Orquestração da geração de ideias
    security/                 Validação de origem IPC e rede pública
    storage/                  Banco de conteúdo e backups
    theme-research/           Serviço de pesquisa temática
    index.ts                  Inicialização do processo principal
  preload/                    API mínima exposta ao renderer
  renderer/
    features/                 Interfaces agrupadas por funcionalidade
    index.html                Casca da aplicação
    main.ts                   Inicialização e navegação da interface
    style.css                 Estilos da aplicação
extensions/                   Extensões de navegador
workers/                      Processos auxiliares isolados
scripts/                      Empacotamento e avaliadores independentes
tests/windows/                Suíte nativa Windows do Gate 0
```

## Limites entre camadas

- `core` contém contratos, normalização e regras de domínio. Não importa código do Electron, do Node.js ou da interface.
- `main` coordena armazenamento, rede, provedores e processos auxiliares. Toda operação privilegiada começa aqui.
- `preload` expõe somente métodos explícitos ao renderer; não encaminha IPC genérico nem APIs do Node.
- `renderer` cuida da interação e chama apenas as APIs tipadas do preload.
- `workers/project-context` é um processo separado. O processo principal valida os dados e controla seu ciclo de vida.
- `extensions/chrome-edge` envia URLs pelo protocolo registrado `loounp://`; ela não acessa os bancos locais.

## Organização de código e testes

- Mantenha cada funcionalidade dentro do diretório de domínio correspondente nas camadas `core`, `main` e `renderer`.
- Coloque testes TypeScript junto ao módulo com o sufixo `.test.ts`. Eles são descobertos recursivamente por `vitest.config.ts`.
- Testes Python permanecem ao lado do worker que verificam; o comando `npm run test:python` executa essa suíte no Windows.
- Gates 0, 2 e 3 são avaliadores independentes e não fazem parte de `npm test` nem da CI padrão. O Gate 3 lê o banco local do aplicativo e grava o relatório em `local-only/gate3-results.json`, fora do Git.
- Deixe configurações reconhecidas automaticamente na raiz. Artefatos gerados ficam em `out/` e `release/`; conteúdo local fica em `local-only/`.

## Arquivos locais do Codex

`.codex/`, `.agents/`, `.claude/` e `AGENTS.md` são configuração local de ferramentas de agentes e ficam fora do Git. Podem não existir em outros clones e não são necessários para compilar, executar ou testar o aplicativo. Instruções e documentação compartilhadas ficam em `README.md` e `docs/`.

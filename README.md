# Loounp — descoberta pessoal e ideias de projeto

Aplicativo desktop local para testar se um mapa explícito de interesses, refinado por avaliações pessoais, encontra leituras mais úteis. A POC coleta artigos do Dev.to e feeds RSS do Medium, ordena o catálogo com regras explicáveis e registra feedback localmente.

## Organização do projeto

- `src/core/`: regras e contratos de domínio agrupados por funcionalidade.
- `src/main/`: serviços do Electron agrupados por domínio; `index.ts` inicia o processo e conecta as partes.
- `src/preload/`: API tipada e restrita entre o processo principal e a interface.
- `src/renderer/features/`: telas e interações agrupadas por funcionalidade.
- `extensions/chrome-edge/`: extensão para enviar páginas ao Loounp.
- `workers/project-context/`: worker Python isolado para análise de projetos.
- `scripts/` e `tests/windows/`: empacotamento, avaliações e Gate 0 do Windows.
- `.codex/`, `.agents/` e `.claude/`: configuração local de ferramentas de agentes, ignorada pelo Git e não necessária para executar o aplicativo.
- `docs/`: arquitetura e documentação geral do projeto.
- `local-only/`: relatórios e notas locais, ignorados pelo Git.
- `release/` e `out/`: arquivos gerados durante build; não entram no Git.

Veja [arquitetura](docs/ARCHITECTURE.md) para os limites entre camadas, regras de organização e mapa detalhado do repositório.

## Executar

Requisitos: Node.js 20.19+ (ou 22.12+) e npm. Na primeira execução, o pacote Electron baixa o binário desktop correspondente ao sistema.

```powershell
npm ci
npm run dev
```

Para verificar ou preparar a versão compilada:

```powershell
npm run typecheck
npm test
npm run test:python
npm run build
npm start
```

`npm run test:python` precisa ser executado no Windows. O Gate 0 e as avaliações Gate 2/3 são comandos separados porque dependem de um runtime Windows e de fixtures próprias.

## Executável para Windows

Para gerar o instalador e a versão portátil (Windows x64):

```powershell
npm run dist:win
```

O script cria uma pasta com data e hora em `release/` para cada geração. O instalador fica nessa pasta; a versão portable mais recente também é copiada para um caminho estável na raiz de `release/`:

- `release/build-<data-hora>/Loounp-0.1.0-setup-x64.exe`: instalador com atalhos no Menu Iniciar e na área de trabalho.
- `release/Loounp-0.1.0-portable-x64.exe`: versão portátil mais recente, que abre com duplo clique sem instalação.
- `release/chrome-edge-extension/`: extensão Chrome/Edge mais recente.

O executável mantém os dados locais em `%APPDATA%\content-discovery-poc`, compartilhados com a versão iniciada por `npm run dev`.

## Captura rápida e bandeja do Windows

Use **Capturar link** no Loounp para colar uma URL. Para enviar uma página ou um link direto do Chrome/Edge:

1. Abra `chrome://extensions` ou `edge://extensions` e ative o **Modo do desenvolvedor**.
2. Selecione **Carregar sem compactação** e escolha `chrome-edge-extension` dentro da pasta de geração mais recente em `release/` (ou `extensions/chrome-edge` no checkout do projeto).
3. Abra o Loounp ao menos uma vez para registrar o protocolo `loounp://`. Depois, clique com o botão direito em uma página ou link e selecione **Enviar artigo ao Loounp**. Na primeira vez, o navegador pedirá autorização para abrir o aplicativo.

No Windows, fechar pelo X mantém o Loounp na bandeja. No macOS, fechar a última janela mantém o processo e o agendador ativos até sair pelo menu do aplicativo. A busca diária usa o horário GMT-03:00 definido em Configurações e mostra notificações de novos artigos no Windows.

## Usar a POC

1. Abra **Ajustar meus interesses** e edite os temas e sua importância de 1 a 5. O perfil inicial traz exemplos editáveis.
2. Ajuste as URLs de RSS do Medium (uma por linha) e o equilíbrio entre conteúdo recente e duradouro.
3. Use **Buscar conteúdo** para consultar os temas no Dev.to e os feeds RSS configurados a qualquer momento. Em **Configurações**, escolha busca automática desligada, a cada 6h, a cada 12h ou diariamente no horário GMT-03:00 definido.
4. Abra artigos, salve para ler depois e use **Útil** / **Não** como avaliação explícita. Avaliações têm mais peso no ranking que abertura ou salvamento.
5. Opcionalmente, configure uma chave OpenAI para gerar resumo e análise editorial com GPT-5.6 Luna. A análise usa apenas título e trecho disponível.
6. Use **Posts LinkedIn** para criar um rascunho em português a partir de um artigo (URL, feed ou texto colado), de uma ideia escrita ou de uma ideia salva. Revise um dos três hooks, edite e copie o texto. Cada rascunho inclui um horário futuro sugerido em GMT-03:00 e fica salvo localmente. O Loounp não publica por você.
7. Opcionalmente, configure uma chave Jev e use **Comparar com Jev** em artigos individuais. Essa classificação é um experimento paralelo, não muda o ranking, e pode consumir créditos da conta Jev.
8. Em **Ajustar meus interesses → Backup dos dados**, use **Exportar dados** para salvar perfil, catálogo, avaliações, ideias, rascunhos LinkedIn e memória em um arquivo JSON, e **Selecionar backup para importar** para restaurá-lo neste ou em outro computador. Importar substitui os dados atuais e antes salva uma cópia `.bak` de cada banco na pasta de dados. Chaves de API não entram no arquivo e precisam ser configuradas de novo em outra máquina; trechos de código citados nas ideias entram.

As chaves são criptografadas pelo armazenamento seguro do sistema operacional e usadas no processo principal. O perfil, catálogo e feedback ficam em SQLite sob o diretório de dados do app do usuário (`%APPDATA%\content-discovery-poc` no Windows); ideias, memória e contexto de projetos ficam em um segundo banco em `article-to-project\` na mesma pasta. Não há conta, sincronização nem serviço remoto próprio.

## Limites conhecidos

- A descoberta do Dev.to usa um conjunto pequeno de tags derivadas dos temas e pode não reconhecer sinônimos customizados.
- O Medium oferece somente o conteúdo presente nos feeds RSS adicionados; artigos pagos podem ter descrição incompleta. Para gerar uma ideia de projeto a partir de um artigo pago que você consegue ler, use **Colar texto completo** e cole o conteúdo do artigo.
- O enriquecimento por IA é opcional e sob demanda. Sem credenciais, o feed ainda busca, classifica heurísticamente, ordena e registra feedback.
- A POC não publica posts diretamente no LinkedIn, não integra X, não treina modelos e não calcula embeddings. Para gerar ideias de projeto ou posts a partir de uma URL, ela busca o HTML da página informada e extrai o texto do artigo — não faz varredura automática de sites nem indexação em massa.
- A busca automática roda enquanto o processo do Loounp estiver ativo; no Windows, sair pelo menu da bandeja ou desligar o computador interrompe as buscas.

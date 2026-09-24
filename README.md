# Loounp — descoberta pessoal e ideias de projeto

Aplicativo desktop local para testar se um mapa explícito de interesses, refinado por avaliações pessoais, encontra leituras mais úteis. A POC coleta artigos do Dev.to e feeds RSS do Medium, ordena o catálogo com regras explicáveis e registra feedback localmente.

## Executar

Requisitos: Node.js 20.19+ (ou 22.12+) e npm. Na primeira execução, o pacote Electron baixa o binário desktop correspondente ao sistema.

```powershell
npm install
npm run dev
```

Para verificar ou preparar a versão compilada:

```powershell
npm run typecheck
npm test
npm run build
npm start
```

## Usar a POC

1. Abra **Ajustar meus interesses** e edite os temas e sua importância de 1 a 5. O perfil inicial traz exemplos editáveis.
2. Ajuste as URLs de RSS do Medium (uma por linha) e o equilíbrio entre conteúdo recente e duradouro.
3. Use **Buscar conteúdo** para consultar os temas no Dev.to e os feeds RSS configurados. A busca é manual e pode ser repetida.
4. Abra artigos, salve para ler depois e use **Útil** / **Não** como avaliação explícita. Avaliações têm mais peso no ranking que abertura ou salvamento.
5. Opcionalmente, configure uma chave OpenAI para gerar resumo e análise editorial com GPT-5.6 Luna. A análise usa apenas título e trecho disponível.
6. Opcionalmente, configure uma chave Jev e use **Comparar com Jev** em artigos individuais. Essa classificação é um experimento paralelo, não muda o ranking, e pode consumir créditos da conta Jev.
7. Em **Ajustar meus interesses → Backup dos dados**, use **Exportar dados** para salvar perfil, catálogo, avaliações, ideias e memória em um arquivo JSON, e **Selecionar backup para importar** para restaurá-lo neste ou em outro computador. Importar substitui os dados atuais e antes salva uma cópia `.bak` de cada banco na pasta de dados. Chaves de API não entram no arquivo e precisam ser configuradas de novo em outra máquina; trechos de código citados nas ideias entram.

As chaves são criptografadas pelo armazenamento seguro do sistema operacional e usadas no processo principal. O perfil, catálogo e feedback ficam em SQLite sob o diretório de dados do app do usuário (`%APPDATA%\content-discovery-poc` no Windows); ideias, memória e contexto de projetos ficam em um segundo banco em `article-to-project\` na mesma pasta. Não há conta, sincronização nem serviço remoto próprio.

## Limites conhecidos

- A descoberta do Dev.to usa um conjunto pequeno de tags derivadas dos temas e pode não reconhecer sinônimos customizados.
- O Medium oferece somente o conteúdo presente nos feeds RSS adicionados; artigos pagos podem ter descrição incompleta. Para gerar uma ideia de projeto a partir de um artigo pago que você consegue ler, use **Colar texto completo** e cole o conteúdo do artigo.
- O enriquecimento por IA é opcional e sob demanda. Sem credenciais, o feed ainda busca, classifica heurísticamente, ordena e registra feedback.
- A POC não integra X ou LinkedIn, não treina modelos e não calcula embeddings. Para gerar ideias de projeto a partir de uma URL, ela busca o HTML da página informada e extrai o texto do artigo — não faz varredura automática de sites nem indexação em massa.

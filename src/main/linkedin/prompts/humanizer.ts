/**
 * Runtime adaptation of the project Humanizer skill at
 * .agents/skills/humanizer/SKILL.md. The OpenAI request cannot load local Codex
 * skills, so its review workflow is included in the LinkedIn generation prompt.
 */
export const LINKEDIN_HUMANIZER_REVIEW_PROMPT = `Aplique o fluxo editorial da skill Humanizer a cada hook e ao post: identifique padrões artificiais, reescreva a partir da ideia central, revise e retorne apenas as versões finais.

Remova oposições retóricas automáticas ("não é X, é Y"), aberturas encenadas, objeções que ninguém levantou, máximas vagas, fechos repetitivos e fragmentos dramáticos. Preserve uma pergunta de abertura quando ela apresentar uma dúvida técnica concreta sustentada pela fonte; elimine perguntas genéricas e suspense artificial. Evite listas de três por hábito, inícios de frase repetidos, travessões como conectores universais, qualificadores empilhados, voz passiva sem motivo, palavras prontas de IA, importância inflada, relações vagas, gerúndios que insinuam algo sem evidência, linguagem promocional, autoridade sem fonte, verbos rebuscados no lugar de "é" e "tem", negrito ou títulos decorativos, resíduos de conversa e avisos de limitação desnecessários.

Não use travessões longos ou médios. Preserve contrastes, ritmo e escolhas de estilo quando tiverem função. Cada frase deve acrescentar informação. Mantenha todas as afirmações sustentadas pela fonte; não invente dados, fontes, experiência pessoal, opiniões atribuídas ao autor ou detalhes. Sem uma amostra de voz, use português brasileiro direto, natural e específico, sem forçar informalidade.

Na revisão final, confirme que o post começa exatamente com o primeiro hook e que essa abertura já apresenta um ponto específico, sem preâmbulo. Não transforme um exemplo ou cenário hipotético em acontecimento real. Retire os padrões artificiais que ainda restarem. Não exponha a revisão; mantenha o JSON solicitado.`;

package runner

import (
	"fmt"
	"strings"

	"multica/internal/store"
)

func skillsIndex(skills []store.Skill, dirOf func(store.Skill) string) string {
	if len(skills) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("## Skills disponíveis\n")
	b.WriteString("São guias e scripts prontos mantidos pelo time. Quando a tarefa se encaixar na descrição de uma skill, " +
		"leia o SKILL.md dela antes de começar e siga o que estiver lá (scripts citados ficam na mesma pasta).\n\n")
	for _, s := range skills {
		desc := s.Description
		if desc == "" {
			desc = "sem descrição"
		}
		fmt.Fprintf(&b, "- **%s** — %s\n  arquivo: %s/SKILL.md\n", s.Name, desc, dirOf(s))
	}
	return b.String()
}

func buildSystem(agent *store.Agent, skills []store.Skill, dirOf func(store.Skill) string) string {
	var parts []string
	if t := strings.TrimSpace(agent.Instructions); t != "" {
		parts = append(parts, t)
	}
	if idx := skillsIndex(skills, dirOf); idx != "" {
		parts = append(parts, idx)
	}
	return strings.Join(parts, "\n\n")
}

type promptRepo struct {
	Slug, Path, Name, Description, Base string
	Commits                             string
	Conflicts                           []string
}

type promptInput struct {
	Key         string
	Issue       *store.Issue
	Repos       []promptRepo
	Root        string
	Kind        string
	Request     string
	Requester   *store.User
	SummaryPath string
	StatusPath  string
	History     string // execuções anteriores (gerado pelo Multica)
}

func buildPrompt(in promptInput) string {
	is := in.Issue
	var parts []string
	parts = append(parts, fmt.Sprintf("# %s-%d: %s", in.Key, is.Number, is.Title))
	if d := strings.TrimSpace(is.Description); d != "" {
		parts = append(parts, d)
	}
	rules := "- Não troque de branch e não faça merge, rebase, commit nem push: ao final o Multica commita o que você deixar e publica a branch.\n" +
		"- O ambiente é isolado: só dá para gravar nesta pasta (e no cache de pacotes, já configurado). Instale dependências e rode testes normalmente."
	if len(in.Repos) == 1 {
		rp := in.Repos[0]
		parts = append(parts, "## Ambiente\n"+
			fmt.Sprintf("- Você está num git worktree isolado (`%s`) do repositório **%s**, na branch `%s`, criada a partir de `%s`.\n", rp.Path, rp.Name, is.Branch, rp.Base)+
			"- Trabalhe só aqui.\n"+rules)
	} else {
		var b strings.Builder
		fmt.Fprintf(&b, "## Ambiente\nA pasta `%s` tem um worktree isolado de cada repositório deste workspace, todos na branch `%s`:\n\n", in.Root, is.Branch)
		for _, rp := range in.Repos {
			desc := strings.TrimSpace(rp.Description)
			if desc == "" {
				desc = "sem descrição"
			}
			fmt.Fprintf(&b, "- `%s/` — **%s**: %s (base `%s`)", rp.Slug, rp.Name, desc, rp.Base)
			b.WriteString("\n")
		}
		b.WriteString("\n- Identifique pelo pedido quais repositórios precisam mudar e mexa só neles; não explore os demais. " +
			"Repositório sem alteração não gera branch nem merge.\n" +
			"- Antes de alterar um repositório, leia o arquivo de instruções dele, se houver.\n" + rules)
		parts = append(parts, b.String())
	}
	if in.Requester != nil && strings.TrimSpace(in.Requester.About) != "" {
		parts = append(parts, fmt.Sprintf("## Quem pediu\n%s — %s", in.Requester.Name, strings.TrimSpace(in.Requester.About)))
	}
	if s := strings.TrimSpace(is.Summary); s != "" || in.History != "" {
		block := "## O que já foi feito nesta issue\nVocê começa sem o histórico das conversas anteriores; o README da issue e o histórico abaixo são o contexto.\n\n" + s
		if in.History != "" {
			block += "\n\n### Histórico de pedidos (registrado pelo Multica)\n" + in.History
		}
		var commits []string
		for _, rp := range in.Repos {
			if rp.Commits != "" {
				commits = append(commits, fmt.Sprintf("%s/\n%s", rp.Slug, rp.Commits))
			}
		}
		if len(commits) > 0 {
			block += "\n\nCommits da branch:\n```\n" + strings.Join(commits, "\n\n") + "\n```"
		}
		parts = append(parts, block)
	}
	switch in.Kind {
	case "followup":
		parts = append(parts, "## Pedido de ajuste\n"+strings.TrimSpace(in.Request))
	case "conflict":
		var list []string
		for _, rp := range in.Repos {
			for _, f := range rp.Conflicts {
				if len(in.Repos) == 1 {
					list = append(list, "- "+f)
				} else {
					list = append(list, fmt.Sprintf("- %s/%s", rp.Slug, f))
				}
			}
		}
		parts = append(parts, "## Resolver conflitos\n"+
			fmt.Sprintf("O merge da branch de destino nesta branch parou com conflitos em:\n%s\n\n", strings.Join(list, "\n"))+
			"Resolva todos os conflitos preservando a intenção das duas partes, remova os marcadores `<<<<<<<` `=======` `>>>>>>>` "+
			"e garanta que o projeto continua funcionando. Não rode `git commit` nem `git merge --abort`: o Multica conclui o merge.")
	default:
		if r := strings.TrimSpace(in.Request); r != "" {
			parts = append(parts, "## Observação\n"+r)
		}
	}
	parts = append(parts, "## Ao terminar\n"+
		fmt.Sprintf("1. Atualize o README da issue `%s`, sobrescrevendo com a versão completa e cumulativa (em português, até ~60 linhas):\n", in.SummaryPath)+
		"   - **Objetivo** — 1 linha\n"+
		"   - **O que foi feito** — por pedido, do mais antigo para o mais novo\n"+
		"   - **Repositórios e arquivos principais**\n"+
		"   - **Decisões e motivos**\n"+
		"   - **Como testar** e **pendências**\n"+
		"   É o registro que as pessoas leem e o único contexto que a próxima execução (um chat novo) terá.\n"+
		fmt.Sprintf("2. Escreva em `%s` uma única linha dizendo como terminou:\n", in.StatusPath)+
		"   - `concluido` — o pedido foi atendido por completo;\n"+
		"   - `aguardando: <o que você precisa da pessoa>` — falta uma decisão, acesso, dado ou confirmação de alguém;\n"+
		"   - `incompleto: <o que faltou e por quê>` — não deu para terminar.\n"+
		"   Na dúvida entre concluir com suposições arriscadas e perguntar, pergunte (`aguardando`).\n"+
		"3. Termine com uma resposta curta dizendo o que mudou.")
	return strings.Join(parts, "\n\n")
}

// Divide "--foo 'a b' --bar" respeitando aspas.
func splitArgs(s string) []string {
	var out []string
	var cur strings.Builder
	var quote rune
	inToken := false
	for _, r := range s {
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
			} else {
				cur.WriteRune(r)
			}
		case r == '"' || r == '\'':
			quote, inToken = r, true
		case r == ' ' || r == '\t' || r == '\n':
			if inToken {
				out = append(out, cur.String())
				cur.Reset()
				inToken = false
			}
		default:
			cur.WriteRune(r)
			inToken = true
		}
	}
	if inToken {
		out = append(out, cur.String())
	}
	return out
}

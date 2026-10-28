package api

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

// Mensagens em inglês para quem usa a interface em inglês: o front manda
// X-Lang: en. A chave é o texto (ou o formato do fmt) em português, como está
// no código; o que não estiver aqui sai em português.

type langKey struct{}

// withLang guarda o idioma do pedido no contexto.
func withLang(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.Header.Get("X-Lang"), "en") {
			r = r.WithContext(context.WithValue(r.Context(), langKey{}, "en"))
		}
		next.ServeHTTP(w, r)
	})
}

func english(ctx context.Context) bool { return ctx.Value(langKey{}) == "en" }

// tr traduz o formato e os argumentos de texto que estiverem no mapa.
func tr(ctx context.Context, format string, args ...any) string {
	if english(ctx) {
		if en, ok := enMsgs[format]; ok {
			format = en
		}
		args = append([]any(nil), args...)
		for i, a := range args {
			if s, ok := a.(string); ok {
				if en, ok := enMsgs[s]; ok {
					args[i] = en
				}
			}
		}
	}
	if len(args) == 0 {
		return format
	}
	return fmt.Sprintf(format, args...)
}

var enMsgs = map[string]string{
	// gerais
	"não encontrado": "not found",
	"já existe um registro com esse nome/chave":                       "a record with that name/key already exists",
	"JSON inválido: %v":                                               "invalid JSON: %v",
	"seu perfil não tem permissão para isso":                          "your role isn't allowed to do that",
	"só o dono do Multica define perfis":                              "only the Multica owner manages roles",
	"o Multica já foi configurado":                                    "Multica is already set up",
	"e-mail ou senha incorretos":                                      "wrong email or password",
	"e-mail inválido":                                                 "invalid email",
	"a senha precisa de pelo menos 8 caracteres":                      "the password needs at least 8 characters",
	"só o próprio dono altera a conta dele":                           "only the owner can change their own account",
	"o dono do Multica não pode ser removido":                         "the Multica owner can't be removed",
	"você não pode remover a si mesmo":                                "you can't remove yourself",
	"perfil inválido":                                                 "invalid role",
	"permissão desconhecida: %s":                                      "unknown permission: %s",
	"dê um nome ao perfil":                                            "give the role a name",
	"já existe um perfil com esse nome":                               "a role with that name already exists",
	"%d usuário(s) usam este perfil; troque o perfil deles antes":     "%d user(s) have this role; change their role first",
	"a preferência precisa ser um objeto JSON de até 16 KB":           "the preference must be a JSON object of up to 16 KB",
	"informe o nome":                                                  "enter the name",
	"informe o nome e uma chave de 2 a 10 letras/números (ex.: LING)": "enter the name and a key of 2 to 10 letters/numbers (e.g. LING)",
	"chave inválida":                                                  "invalid key",
	"a pessoa não tem acesso a este workspace":                        "that person doesn't have access to this workspace",
	"essa pessoa não tem acesso a este workspace":                     "that person doesn't have access to this workspace",
	"informe o nome da label":                                         "enter the label name",
	"label não existe neste workspace":                                "label doesn't exist in this workspace",

	// permissões e etapas
	"seu perfil não pode %s":                                                   "your role can't %s",
	"seu perfil não pode alterar %s":                                           "your role can't change %s",
	"seu perfil não pode executar agentes":                                     "your role can't run agents",
	"%s é somente leitura: a issue não muda mais aqui":                         "%s is read-only: the issue doesn't change here anymore",
	"%s é somente leitura":                                                     "%s is read-only",
	"na etapa %s, só %s mexe nas issues":                                       "in the %s stage, only %s works on issues",
	"na etapa %s, %s fica travado":                                             "in the %s stage, %s is locked",
	"só %s pode trazer issues para %s":                                         "only %s can bring issues to %s",
	"%s já tem o máximo de %d issues; termine alguma antes":                    "%s already has the maximum of %d issues; finish one first",
	"para entrar em %s a issue precisa de um agente":                           "to enter %s the issue needs an agent",
	"para entrar em %s a issue precisa de um responsável":                      "to enter %s the issue needs an assignee",
	"para entrar em %s a issue precisa de descrição":                           "to enter %s the issue needs a description",
	"para entrar em %s a issue precisa ter alterações de código":               "to enter %s the issue needs code changes",
	"em %s, só %s aprova":                                                      "in %s, only %s approves",
	"esta etapa não tem aprovação":                                             "this stage has no approval",
	"espere a execução terminar para aprovar":                                  "wait for the run to finish before approving",
	"etapa inválida":                                                           "invalid stage",
	"dê um nome à etapa":                                                       "give the stage a name",
	"envie a ordem de todas as etapas":                                         "send the order of every stage",
	"etapa faltando na ordem: %s":                                              "stage missing from the order: %s",
	"etapas do sistema não podem ser removidas (dá para renomear e reordenar)": "built-in stages can't be removed (they can be renamed and reordered)",
	"perfil %s":              "role %s",
	"outras pessoas":         "other people",
	"%s: perfil inexistente": "%s: role doesn't exist",
	"%s: %s não tem acesso a este workspace": "%s: %s doesn't have access to this workspace",
	// o que o perfil não pode (need) e campos (fieldRules)
	"aprovar issues":             "approve issues",
	"comentar":                   "comment",
	"definir a prioridade":       "set the priority",
	"definir labels":             "set labels",
	"definir o responsável":      "set the assignee",
	"escolher o agente da issue": "choose the issue's agent",
	"escolher repositórios":      "choose repositories",
	"o título":                   "the title",
	"a descrição":                "the description",
	"o README":                   "the README",
	"a prioridade":               "the priority",
	"as labels":                  "the labels",
	"o agente":                   "the agent",
	"as skills":                  "the skills",
	"o responsável":              "the assignee",
	"os repositórios":            "the repositories",
	"a etapa":                    "the stage",
	"a ordem":                    "the order",

	// regras
	"gatilho desconhecido":                                 "unknown trigger",
	"ação desconhecida":                                    "unknown action",
	"escolha a etapa":                                      "choose the stage",
	"escolha a etapa do gatilho":                           "choose the trigger's stage",
	"condições inválidas":                                  "invalid conditions",
	"configuração inválida":                                "invalid configuration",
	"informe depois de quantas horas parada":               "enter after how many idle hours",
	"informe o valor em US$":                               "enter the amount in US$",
	"escolha para quem notificar":                          "choose whom to notify",
	"escolha ao menos um perfil ou usuário":                "choose at least one role or user",
	"escolha ao menos um perfil ou pessoa":                 "choose at least one role or person",
	"escolha quem vai ser o responsável":                   "choose who will be the assignee",
	"escolha a etapa de destino (diferente da do gatilho)": "choose the target stage (different from the trigger's)",
	"informe a URL do webhook (http/https)":                "enter the webhook URL (http/https)",
	"escreva o script":                                     "write the script",
	"escolha o agente":                                     "choose the agent",
	"escolha uma label deste workspace":                    "choose a label from this workspace",
	"escreva o comentário":                                 "write the comment",
	"etapa de falha inválida":                              "invalid failure stage",
	"escolha o que fica travado":                           "choose what gets locked",
	"escolha o que a issue precisa ter":                    "choose what the issue must have",
	"informe o limite de issues":                           "enter the issue limit",
	"de 1 a 10 aprovações":                                 "from 1 to 10 approvals",
	"escolha para onde a issue vai quando aprovada":        "choose where the issue goes once approved",
	"Destinatários":                                        "Recipients",
	"Responsável":                                          "Assignee",
	"Pessoas da regra":                                     "People in the rule",
	"escolha outro workspace de destino":                   "choose another destination workspace",
	"envie JSON: {title, description, priority} ou {subject, text, from}": "send JSON: {title, description, priority} or {subject, text, from}",
	"faltou o título (title ou subject)":                                  "the title is missing (title or subject)",
	"URL do webhook inválida":                                             "invalid webhook URL",
	"muitas mudanças automáticas seguidas; parei para não entrar em loop": "too many automatic changes in a row; stopped to avoid a loop",

	// issues, agentes, repositórios
	"dê um título à issue":                                 "give the issue a title",
	"o título não pode ficar vazio":                        "the title can't be empty",
	"comentário vazio":                                     "empty comment",
	"descreva o ajuste":                                    "describe the adjustment",
	"atribua um agente à issue":                            "assign an agent to the issue",
	"essa issue já tem uma execução na fila ou rodando":    "this issue already has a run queued or running",
	"nada rodando":                                         "nothing running",
	"nada a fazer":                                         "nothing to do",
	"agente não encontrado":                                "agent not found",
	"dê um nome ao agente":                                 "give the agent a name",
	"dê um nome à skill":                                   "give the skill a name",
	"escolha pelo menos um repositório":                    "choose at least one repository",
	"escolha a pessoa":                                     "choose the person",
	"repositório não pertence a este workspace":            "repository doesn't belong to this workspace",
	"informe a URL do repositório":                         "enter the repository URL",
	"já existe um repositório chamado %q neste workspace":  "a repository named %q already exists in this workspace",
	"não consegui acessar o repositório: %v":               "couldn't reach the repository: %v",
	"não é um repositório git acessível pelo servidor: %v": "not a git repository the server can reach: %v",
	"o workspace não tem repositório: cadastre um em Workspace e membros": "the workspace has no repository: add one under Workspace",
	"nenhum repositório alterado":                                         "no repository changed",
	"nenhum repositório com alterações para fazer merge":                  "no repository with changes to merge",
	"conflito; nada foi publicado: use \"Resolver conflito com IA\"":      "conflict; nothing was published: use \"Resolve conflict with AI\"",
	"ninguém dos perfis/usuários escolhidos tem acesso a este workspace":  "none of the chosen roles/users has access to this workspace",

	// catálogo de permissões (grupos e rótulos)
	"Telas":                                 "Screens",
	"Fluxo":                                 "Workflow",
	"Agentes":                               "Agents",
	"Repositórios":                          "Repositories",
	"Usuários":                              "Users",
	"Servidor":                              "Server",
	"Criar issues":                          "Create issues",
	"Editar título, descrição e README":     "Edit title, description and README",
	"Mover issues entre etapas e reordenar": "Move issues between stages and reorder",
	"Comentar":                              "Comment",
	"Definir prioridade":                    "Set priority",
	"Definir labels":                        "Set labels",
	"Escolher o agente da issue":            "Choose the issue's agent",
	"Escolher repositórios e branches da issue":                   "Choose the issue's repositories and branches",
	"Definir o responsável":                                       "Set the assignee",
	"Executar agentes (rodar, pedir ajuste, responder, cancelar)": "Run agents (run, ask for changes, reply, cancel)",
	"Aprovar issues em etapas com aprovação":                      "Approve issues in stages with approval",
	"Fazer merge e descartar branches":                            "Merge and discard branches",
	"Excluir issues":                                              "Delete issues",
	"Labels":                                                      "Labels",
	"Ver a tela de labels":                                        "View the labels screen",
	"Criar labels":                                                "Create labels",
	"Renomear e trocar a cor das labels":                          "Rename and recolor labels",
	"Apagar labels (saem das issues)":                             "Delete labels (removed from issues)",
	"Ver Analytics":                                               "View Analytics",
	"Ver o fluxo e as automações (só leitura)":                    "View the workflow and automations (read-only)",
	"Configurar etapas, acessos e automações (inclui scripts)":    "Configure stages, access and automations (includes scripts)",
	"Copiar o fluxo de um workspace para outro":                   "Copy the workflow from one workspace to another",
	"Ver agentes":                                                 "View agents",
	"Criar agentes":                                               "Create agents",
	"Editar agentes":                                              "Edit agents",
	"Arquivar agentes":                                            "Archive agents",
	"Ver skills":                                                  "View skills",
	"Criar skills":                                                "Create skills",
	"Editar skills e vincular a agentes":                          "Edit skills and link them to agents",
	"Excluir skills":                                              "Delete skills",
	"Ver repositórios, pessoas e labels do workspace":             "View the workspace's repositories, people and labels",
	"Criar workspaces":                                            "Create workspaces",
	"Renomear workspaces":                                         "Rename workspaces",
	"Excluir workspaces":                                          "Delete workspaces",
	"Ver todos os workspaces (sem precisar de vínculo)":           "See every workspace (without being added)",
	"Vincular e desvincular pessoas":                              "Add and remove people",
	"Adicionar repositórios":                                      "Add repositories",
	"Editar repositórios":                                         "Edit repositories",
	"Remover repositórios":                                        "Remove repositories",
	"Ver usuários e o perfil de cada um (o que faz em cada workspace)": "View users and each one's profile (what they do in each workspace)",
	"Criar usuários":                   "Create users",
	"Editar usuários, senhas e perfis": "Edit users, passwords and roles",
	"Remover usuários":                 "Remove users",
	"Configurar e-mail e servidor":     "Configure email and server",

	// alertas do fluxo e perfil de uma pessoa
	"Etapa %s · %s":                                                  "Stage %s · %s",
	"Regra %s":                                                       "Rule %s",
	"usuário removido":                                               "removed user",
	"%s não tem acesso a este workspace":                             "%s doesn't have access to this workspace",
	"um perfil usado aqui foi excluído":                              "a role used here was deleted",
	"a label desta regra não existe neste workspace":                 "this rule's label doesn't exist in this workspace",
	"o agente desta regra foi arquivado":                             "this rule's agent was archived",
	"%s não tem acesso ao destino e sai da lista":                    "%s doesn't have access to the destination and is dropped from the list",
	"ficou sem ninguém e vai desativada; escolha pessoas do destino": "ended up with nobody and will be turned off; choose people from the destination",
	"a label %s será criada no destino":                              "the label %s will be created in the destination",
	"quem mexe":                                                      "who works on it",
	"quem traz issues":                                               "who brings issues",
	"somente leitura":                                                "read-only",
	"campos travados":                                                "locked fields",
	"requisitos":                                                     "requirements",
	"limite de issues":                                               "issue limit",
	"aprovação":                                                      "approval",
	"responsáveis":                                                   "owners",
	"notificar":                                                      "notify",
	"mover":                                                          "move",
	"rodar agente":                                                   "run agent",
	"abrir PR":                                                       "open PR",
	"definir agente":                                                 "set agent",
	"definir prioridade":                                             "set priority",
	"adicionar label":                                                "add label",
	"definir responsável":                                            "set assignee",
	"parar o agente":                                                 "stop the agent",
	"encerrar a issue":                                               "close the issue",
	"etapa inválida nos filtros":                                     "invalid stage in the filters",
	"escolha se a issue fica concluída ou cancelada": "choose whether the issue ends up done or cancelled",
	"o fluxo precisa de pelo menos uma etapa":        "the workflow needs at least one stage",
	"mexe nas issues": "works on issues",
	"traz issues":     "brings issues",
	"aprova":          "approves",
	"é responsável":   "is an owner",
}

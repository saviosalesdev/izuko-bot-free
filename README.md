# 🥷 Izuko Bot Free - Versão 2.5

<div align="center">
  <img src="https://files.catbox.moe/aysh82.png" alt="Izuko Bot Banner" width="100%">
</div>

## 📋 Sobre o Projeto

**Izuko Bot Free** é um bot multifuncional para WhatsApp desenvolvido em Node.js utilizando a biblioteca Baileys. Esta é a versão gratuita e open-source do projeto, oferecendo uma ampla gama de funcionalidades para administração de grupos, moderação, jogos, integração com IA e muito mais.

**Versão atual: 2.5** | **Total de comandos: 163+**

## ✨ Características Principais

- 🛡️ **Sistemas de Moderação**: Anti-link, Anti-flood, Anti-imagem, Sistema de Mute
- 🎮 **Jogos Interativos**: Jogo da Velha, Cara ou Coroa, Eu Nunca, Sorteios, Quiz
- 📊 **Sistema de Ranking**: XP, Níveis e Ranking de Mensagens
- 🤖 **Integração com IA**: ChatGPT, Copilot, Gemini, GPT e Wendel IA para conversas inteligentes
- 🎨 **Geração de Imagens com IA**: Crie imagens personalizadas usando inteligência artificial
- 🎵 **Download de Mídia**: YouTube, Instagram, SoundCloud e mais
- 🎨 **Criação de Figurinhas**: Conversão de imagens e vídeos
- 📤 **Upload de Arquivos**: Catbox, Google Drive, Telegraph
- ⚙️ **Comandos de Administração**: Promote, Demote, Ban, Configurações de Grupo
- 🎉 **Sistema de Boas-Vindas**: Mensagens personalizadas para novos membros
- 📅 **Agendamento**: Agende mensagens e tarefas
- 🎭 **Comandos de Diversão**: Mais de 10 comandos interativos e divertidos

## 🚀 Instalação

### Pré-requisitos

- **Node.js** v20.x (obrigatório)
- **FFmpeg** (para processamento de áudio/vídeo)
- **Git**

### Passos de Instalação

1. **Clone o repositório**
```bash
git clone https://github.com/Ninja28032024/izuko-bot-free.git
cd izuko-bot-free
```
2. **Instale as dependências** ⚠️ **IMPORTANTE**

```bash
npm install
```

> ⚠️ **ATENÇÃO**: Este passo é **OBRIGATÓRIO**! Sem executar `npm install`, você receberá o erro:
> `Error: Cannot find module '@whiskeysockets/baileys'`
>
> O repositório não inclui a pasta `node_modules/` (que contém as dependências). Você **DEVE** executar `npm install` para baixar e instalar todos os módulos necessários.

3. **Configure o bot**

Edite o arquivo `settings/settings.json`:
```json
{
  "prefix": "&",
  "ownerNumber": "LID_DO_DONO@lid",
  "botLid": "LID_DO_BOT@lid",
  "nomeBot": "Izuko Bot",
  "nomeDono": "Seu Nome",
  "versao": "2.5"
}
```

`ownerNumber` e `botLid` devem conter um LID completo, no formato `numeros@lid`; não coloque o número de telefone nesses campos nem acrescente `@lid` ao telefone. Com o bot conectado e os comandos funcionando, envie `&lid-me` em um grupo: a resposta mostra o LID de quem enviou o comando. Use esse valor em `ownerNumber`. Se o bot estiver conectado à mesma conta do dono, use o mesmo LID também em `botLid`; se for outra conta, use o LID dessa outra conta. O comando `&lid-bot` apenas mostra o valor que já está em `botLid`, não descobre o LID automaticamente. Troque `&` pelo prefixo configurado caso ele seja diferente.

4. **Inicie o bot**
```bash
node main.js
```

ou

```bash
sh start.sh
```

Na primeira conexão, o bot solicita o número do celular com código do país e exibe um código numérico de pareamento no terminal. No WhatsApp, acesse **Aparelhos conectados > Conectar aparelho > Conectar com número de telefone** e informe o código. Se uma sessão válida já estiver salva, o pareamento não será solicitado novamente.

Se o aparelho for removido em **Aparelhos conectados**, o WhatsApp invalida a sessão. Ao detectar esse logout, o bot preserva as credenciais antigas em uma pasta `ninja-qr.reauth-*`; na próxima inicialização, solicita um novo pareamento. Pareamentos incompletos são arquivados automaticamente, sem apagar o backup. Se o socket fechar ou expirar (`408`, `428` ou `515`) antes de concluir o pareamento, o bot descarta somente aquela tentativa incompleta e solicita um novo código; sessões já registradas são preservadas.

Para trocar manualmente para outra conta ou forçar um pareamento novo, execute `node main.js --reset-whatsapp-session`. O estado atual será arquivado em `ninja-qr.reauth-*` e o bot iniciará uma sessão limpa. Não use essa opção em cada reinicialização.

### Deploy na Railway

A validação local informa se as credenciais estão ausentes, incompletas ou parecem registradas. Isso não consegue confirmar antecipadamente se o WhatsApp ainda aceita a sessão: a confirmação real acontece ao abrir o socket. Se o WhatsApp responder que a sessão foi desconectada (`401`/`500`), as credenciais são preservadas para diagnóstico, o processo termina com erro e a Railway deve reiniciá-lo para iniciar um pareamento novo.

Configure o serviço Railway para reiniciar em caso de falha e crie um **Volume** montado em `/app/.whatsapp-data`. Adicione estas variáveis:

```text
WHATSAPP_AUTH_DIR=/app/.whatsapp-data/auth
WHATSAPP_PHONE_NUMBER=55DDDNUMERODACONTADEBOT
```

Use em `WHATSAPP_PHONE_NUMBER` o telefone da conta separada do bot, com código do país e somente dígitos. O bot usa essa variável quando precisar pedir o número em um ambiente sem terminal interativo; o código de pareamento continua sendo exibido nos logs para você concluir a conexão no celular. O diretório de autenticação precisa ficar dentro do Volume para sobreviver a reinicializações e novos deploys; sem Volume, será necessário parear novamente quando o armazenamento efêmero for substituído.

Após conectar a conta do bot, configure `botLid` com o LID dessa conta e `ownerNumber` com o LID da sua conta pessoal. Nunca compartilhe os logs de pareamento nem os arquivos dentro do diretório de autenticação: eles permitem acessar a sessão.

### Acesso do dono e moderação

O bot descarta mensagens privadas de contas diferentes de `ownerNumber` e bloqueia a execução de comandos por qualquer remetente que não corresponda a esse LID. Em grupos, mensagens de terceiros continuam chegando ao monitor de moderação; comandos e recursos conversacionais disparados por comandos só podem ser invocados pelo dono. Ações automáticas de moderação (como apagar links) continuam permitidas.

Com o antilink ativo no grupo, o bot apaga o link, aplica bloqueio de mensagens por 10 segundos no primeiro link e 20 segundos no segundo. Esse bloqueio é aplicado removendo mensagens do participante enquanto o período estiver ativo, pois o WhatsApp não oferece uma função nativa de “timeout” individual. O terceiro link em uma janela móvel de 2 minutos remove o participante. O bot precisa ser administrador do grupo para apagar mensagens ou remover participantes; administradores humanos e o dono são isentos.

O comando `&antiflood` inicializa a configuração mesmo que `antiflood_config.json` esteja vazio ou não tenha a propriedade `gruposAtivos`. O comando alterna o recurso apenas no grupo em que foi enviado.

## 📚 Documentação

Para documentação completa sobre todos os comandos e funcionalidades, consulte a [Documentação Completa](DOCUMENTACAO_IZUKO_BOT_VIP.md).

## 🎯 Comandos Principais

### Administração
- `&promote @usuario` - Promove um membro a administrador
- `&demote @usuario` - Remove privilégios de administrador
- `&ban @usuario` - Remove um membro do grupo
- `&grupo-f` / `&grupo-a` - Fecha/Abre o grupo

### Moderação
- `&antilink` - Ativa/desativa proteção contra links
- `&antiflood` - Ativa/desativa proteção contra spam
- `&antiimg` - Ativa/desativa bloqueio de imagens
- `&mute @usuario 10m` - Silencia um usuário

### Inteligência Artificial (Novos!)
- `&chatgpt-ai-gp` - Ativa ChatGPT no grupo
- `&copilot-ai-gp` - Ativa Copilot no grupo
- `&gemini-ai-gp` - Ativa Gemini no grupo
- `&gerarimg-ai` - Gera imagens com IA

### Jogos
- `&velha @oponente` - Inicia jogo da velha
- `&cara-coroa` - Joga cara ou coroa
- `&eununca` - Inicia o jogo "Eu Nunca"
- `&sortear` - Cria um sorteio
- `&quiz` - Inicia um quiz interativo

### Mídia
- `&play música` - Baixa música do YouTube
- `&sticker` - Cria figurinha (marque a mídia)
- `&toimg` - Converte figurinha em imagem
- `&tomp3` - Converte vídeo em áudio

### Utilidades
- `&menu` - Exibe o menu completo (163+ comandos)
- `&ping` - Verifica latência do bot
- `&status` - Mostra status do bot
- `&upload` - Faz upload de mídia

## 🛠️ Tecnologias Utilizadas

- **@whiskeysockets/baileys** - Biblioteca para WhatsApp Web
- **axios** - Cliente HTTP
- **chalk** - Colorização de logs
- **fluent-ffmpeg** - Manipulação de áudio/vídeo
- **sharp** - Processamento de imagens
- **moment-timezone** - Manipulação de datas
- **node-cron** - Agendamento de tarefas

## 📝 Estrutura do Projeto

```
izuko-bot-free/
├── main.js                    # Arquivo principal
├── package.json               # Dependências
├── start.sh                   # Script de inicialização
├── update.sh                  # Script de atualização
├── commands/                  # Comandos do bot (163+)
├── settings/
│   ├── settings.json          # Configurações
│   └── lib/                   # Bibliotecas auxiliares
├── banco de dados/            # Armazenamento de dados
├── escanear/                  # Scanner de membros
├── node_cache/                # Cache temporário
└── temp/                      # Arquivos temporários
```

## 🆕 Novidades da Versão 2.5

- ✨ **19 novos comandos** adicionados
- 🤖 **Integração com múltiplas IAs**: ChatGPT, Copilot e Gemini
- 🎨 **Geração de imagens com IA**
- 🎮 **Sistema de Quiz** interativo
- 🎭 **Novos comandos de diversão**: bebado, beijar, calvo, corno, feio, gay, gostoso e mais
- 📊 **Novos rankings**: rankgay e outros
- 🔧 **Script de atualização automática** (update.sh)
- 🐛 **Correções de bugs** e melhorias de performance
- 📝 **Melhorias na documentação**

## 🤝 Contribuindo

Contribuições são bem-vindas! Sinta-se à vontade para:

1. Fazer fork do projeto
2. Criar uma branch para sua feature (`git checkout -b feature/NovaFuncionalidade`)
3. Commit suas mudanças (`git commit -m 'Adiciona nova funcionalidade'`)
4. Push para a branch (`git push origin feature/NovaFuncionalidade`)
5. Abrir um Pull Request

## 📄 Licença

Este projeto é distribuído sob a licença ISC.

## 👨‍💻 Desenvolvedor

**Ninja Dev's Of Bots**

## ⚠️ Aviso Legal

Este bot é fornecido "como está", sem garantias de qualquer tipo. O uso deste bot é de sua responsabilidade. Certifique-se de respeitar os Termos de Serviço do WhatsApp ao utilizar bots.

## 🌟 Apoie o Projeto

Se este projeto foi útil para você, considere dar uma ⭐ no repositório!

---

<div align="center">
  <strong>Desenvolvido com ❤️ por Ninja Dev's Of Bots</strong>
</div>

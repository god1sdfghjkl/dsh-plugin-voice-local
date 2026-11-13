/**
 * 通话人设：通话期间给系统提示词加一节固定的“像正常人说话”规则，
 * 挂断后自动恢复（没有 voice=1 的 SSE 客户端时该节渲染为空）。
 *
 * 不改会话历史、不改模型路由；只改下一次请求组装出的 system prompt。
 */

const SECTION = 'voice-local:call-persona'

/**
 * 通话中的口吻规则。
 *
 * 重点不是“更温柔”，而是去掉 AI 腔：
 *   - 口语、短句、一次说 1–3 句
 *   - 不列清单、不写标题、不铺垫、不总结
 *   - 不输出 Markdown/代码块/括号动作/表情
 *   - 不复述纠错用户的口语
 */
export const CALL_PERSONA_TEXT = [
  '当前正在语音通话：你的回复会被直接朗读并显示在通话字幕里，请像正常人说话一样回答。',
  '规则：',
  '1. 用口语和短句，一次只说 1–3 句，直接给结论或下一步；不要开场白、不要总结、不要“希望对你有帮助”。',
  '2. 不要 Markdown（标题、列表、编号、表格、加粗）、不要代码块、不要括号里的动作/情绪/旁白、不要表情符号。',
  '3. 不要自称“AI/助手/模型”，不要解释自己正在思考；不确定就自然说“我查一下”“我看看”。',
  '4. 用户说话有停顿、重复、口头禅是正常的，不要复述纠错；听不清就问一句“你刚说的是……吗？”。',
  '5. 需要调用工具时照常调用，但回复里只说你正在做什么，不要输出工具参数或长日志。',
  '通话结束后恢复正常书面风格。',
].join('\n')

/**
 * @param {object} ctx Cordis ctx
 * @param {{enabled?:boolean, isActive:()=>boolean}} opts
 */
export function installCallPersona(ctx, opts = {}) {
  const { enabled = true, isActive } = opts
  if (!enabled || typeof ctx?.inject !== 'function' || typeof isActive !== 'function') return
  ctx.inject(['systemPrompt'], (ctx) => {
    ctx.systemPrompt.section({
      name: SECTION,
      order: 950,
      text: () => (isActive() ? CALL_PERSONA_TEXT : ''),
      interpolate: false,
    })
  })
}

export { SECTION as CALL_PERSONA_SECTION }
import type { Character } from "./character-types";
import type { ApiConfig, PresetConfig, RegexConfig, WorldBookConfig } from "./settings-types";
import type { UserIdentity } from "@/components/settings/user-identity";
import type { AssemblerInput, LLMMessage } from "./llm-prompt-assembler";
import type { CalendarOwnerType, CalendarScheduleItem } from "./calendar-types";
import { loadCharacters } from "./character-storage";
import {
  loadBindingConfig,
  loadApiConfigs,
  loadPresets,
  loadWorldBooks,
  loadRegexes,
  resolveBinding,
  resolveUserIdentity,
} from "./settings-storage";
import { assemblePromptPayload } from "./llm-prompt-assembler";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext } from "./short-term-assembler";
import { getCustomStickerExample, getCustomStickerNames } from "./custom-sticker-storage";
import { previewMessagesForApi, sendLLMRequest, type ChatEngineError } from "./chat-engine";
import { buildCalendarScheduleMarker, clearGeneratedWeekItems, cloneWeekPlanWithManualEdits, normalizeGeneratedScheduleItems, restoreCalendarWeekItems } from "./calendar-storage";
import {
  getWeekDates,
  getWeekStartIso,
  getWeekdayLabel,
  isCalendarTimeRangeAllowed,
  normalizeTime,
  sanitizeScheduleEmoji,
} from "./calendar-utils";

type CalendarAssemblerResolved = {
  apiConfig: ApiConfig;
  preset: PresetConfig | null;
  regexes: RegexConfig[];
  llmMessages: LLMMessage[];
  ownerName: string;
};

function buildSyntheticUserCharacter(identity: UserIdentity | null): Character {
  const now = new Date().toISOString();
  const personaLines = [
    identity?.bio?.trim(),
    identity?.occupation ? `职业：${identity.occupation}` : "",
    identity?.age ? `年龄：${identity.age}` : "",
    identity?.gender && identity.gender !== "保密" ? `性别：${identity.gender}` : "",
    identity?.customSettings?.trim(),
  ].filter(Boolean);

  return {
    id: "__calendar_user__",
    name: identity?.name?.trim() || "用户",
    avatar: identity?.avatarUrl || null,
    persona: personaLines.join("\n") || "这是用户本人。",
    wechatID: "",
    createdAt: now,
    updatedAt: now,
  };
}

function buildCalendarTriggerInstruction(ownerName: string, weekDates: string[]): string {
  return [
    `请为${ownerName}生成 ${weekDates[0]} 到 ${weekDates[6]} 这一周的完整详细日程安排。`,
    "【规范要求】",
    "1. 标签规范：每条日程的标题开头必须带标签，格式为：【事态属性/时间跨度/发生模式】，其中：",
    "   - 事态属性：正务 或 闲娱",
    "   - 时间跨度：短时 或 长程",
    "   - 发生模式：临起 或 预筹",
    "2. 详细要素：标题必须具体明确，必须包含以下5大要素：",
    "   - 出行/交通方式（如：乘JR新干线721次、打车、步行、驾车等）",
    "   - 同行人（如：携团队、与XX同行、独行）",
    "   - 目的地（精确到活动范围，如：东京至京都、京都府厅）",
    "   - 具体事项（如：办理文旅产业联动共建合作项目备案事宜）",
    "   - 预计耗时（短时事件必须精确到小时和整数分钟；长程事件说明天数/时间段）",
    "   - 示例：【正务/长程/预筹】乘JR新干线721次东京至京都，携团队前往京都府厅办理文旅产业联动共建合作项目备案事宜，预计耗时三天。",
    "3. 长程与短时联动（父子层级）：",
    "   - 遇到多日出差、旅行、项目实施等，须先生成一条【长程】日程主卡片（如 span=长程）。",
    "   - 长程如果跨多天，每天长程主标题须体现当天阶段目标（如：【正务/长程/预筹】京都府厅递交备案材料，开展首轮业务磋商）。",
    "   - 在长程时间段内发生的具体时刻节点，生成为【短时】日程（如 span=短时，精确到 HH:MM 时间点）。",
    "4. 输出格式（每行一条 Pipe 分隔）：",
    "   YYYY-MM-DD|开始时间|结束时间|地点|属性(正务/闲娱)|跨度(短时/长程)|模式(临起/预筹)|emoji|标题",
    "   例如：",
    "   2023-09-12|13:00|18:00|京都|正务|长程|预筹|💼|【正务/长程/预筹】乘JR新干线721次东京至京都，携团队前往京都府厅办理文旅产业联动共建合作项目备案事宜，预计耗时三天。",
    "   2023-09-12|13:00|15:15|东京至京都|正务|短时|预筹|🚆|【正务/短时/预筹】乘JR新干线721次由东京出发奔赴京都，携团队同行，预计耗时2小时15分钟。",
  ].join("\n");
}

function stripCodeFences(text: string): string {
  return text
    .replace(/^```[a-zA-Z]*\s*/g, "")
    .replace(/\s*```$/g, "")
    .trim();
}

function parseScheduleLines(rawText: string, weekStart: string): CalendarScheduleItem[] {
  const weekDates = new Set(getWeekDates(weekStart));
  const lines = stripCodeFences(rawText)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const parsed: Array<{
    date: string;
    startTime: string;
    endTime: string;
    location: string;
    title: string;
    attribute?: import("./calendar-types").CalendarScheduleAttribute;
    span?: import("./calendar-types").CalendarScheduleSpan;
    mode?: import("./calendar-types").CalendarScheduleMode;
    emoji?: string;
  }> = [];

  for (const rawLine of lines) {
    const line = rawLine
      .replace(/^[-*]\s*/, "")
      .replace(/^\d+[.)、]\s*/, "")
      .trim();
    if (!line.includes("|")) continue;
    const parts = line.split("|").map(part => part.trim());
    
    // 支持 9 段新格式: YYYY-MM-DD | startTime | endTime | location | attribute | span | mode | emoji | title
    // 也兼容旧格式 (6或7段)
    let date = "";
    let startTime = "";
    let endTime = "";
    let location = "";
    let attribute: import("./calendar-types").CalendarScheduleAttribute | undefined;
    let span: import("./calendar-types").CalendarScheduleSpan | undefined;
    let mode: import("./calendar-types").CalendarScheduleMode | undefined;
    let emoji = "";
    let title = "";

    if (parts.length >= 9) {
      date = parts[0];
      startTime = normalizeTime(parts[1]) || parts[1];
      endTime = normalizeTime(parts[2]) || parts[2];
      location = parts[3] === "无" ? "" : parts[3];
      attribute = (parts[4] === "正务" || parts[4] === "闲娱") ? parts[4] : undefined;
      span = (parts[5] === "短时" || parts[5] === "长程") ? parts[5] : undefined;
      mode = (parts[6] === "临起" || parts[6] === "预筹") ? parts[6] : undefined;
      emoji = sanitizeScheduleEmoji(parts[7]);
      title = parts.slice(8).join("|");
    } else if (parts.length >= 6) {
      date = parts[0];
      // 检查 parts[1] 是周几还是 startTime
      const isPart1Time = /^\d{1,2}:\d{2}$/.test(parts[1]);
      const timeIdx = isPart1Time ? 1 : 2;
      startTime = normalizeTime(parts[timeIdx]) || parts[timeIdx];
      endTime = normalizeTime(parts[timeIdx + 1]) || parts[timeIdx + 1];
      location = parts[timeIdx + 2] === "无" ? "" : parts[timeIdx + 2];
      
      const remaining = parts.slice(timeIdx + 3);
      if (remaining.length >= 2) {
        emoji = sanitizeScheduleEmoji(remaining[0]);
        title = remaining.slice(1).join("|");
      } else {
        title = remaining[0] || "";
      }
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !weekDates.has(date)) continue;
    if (!startTime || !endTime || !isCalendarTimeRangeAllowed(startTime, endTime)) continue;
    if (!title.trim()) continue;

    // 从标题中提取 【属性/跨度/模式】 标签
    const tagMatch = title.match(/^【(正务|闲娱)\/(短时|长程)\/(临起|预筹)】/);
    if (tagMatch) {
      attribute = attribute || (tagMatch[1] as import("./calendar-types").CalendarScheduleAttribute);
      span = span || (tagMatch[2] as import("./calendar-types").CalendarScheduleSpan);
      mode = mode || (tagMatch[3] as import("./calendar-types").CalendarScheduleMode);
    } else if (attribute && span && mode) {
      // 自动补全标题前缀
      title = `【${attribute}/${span}/${mode}】${title}`;
    }

    parsed.push({
      date,
      startTime,
      endTime,
      location,
      title,
      attribute,
      span,
      mode,
      emoji,
    });
  }

  return normalizeGeneratedScheduleItems(parsed);
}

async function resolveCalendarAssemblerInput(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
): Promise<CalendarAssemblerResolved> {
  const bindings = loadBindingConfig();
  const activeSlot = resolveBinding(bindings, ownerType === "character" ? ownerId : undefined, "calendar");

  if (!activeSlot.apiConfigId) {
    throw new Error("未绑定日历 API，请先在配置绑定中为日历设置 API。");
  }

  const apiConfigs = loadApiConfigs();
  const apiConfig = apiConfigs.find(entry => entry.id === activeSlot.apiConfigId);
  if (!apiConfig) {
    throw new Error("日历 API 配置不存在。");
  }

  const presets = loadPresets();
  let preset = activeSlot.presetId ? presets.find(entry => entry.id === activeSlot.presetId) ?? null : null;
  if (!preset) preset = presets.find(entry => entry.builtIn) ?? null;

  const allWorldBooks = loadWorldBooks();
  const worldBooks = (activeSlot.worldBookIds || [])
    .map(id => allWorldBooks.find(entry => entry.id === id))
    .filter(Boolean) as WorldBookConfig[];

  const allRegexes = loadRegexes();
  const regexes = (activeSlot.regexIds || [])
    .map(id => allRegexes.find(entry => entry.id === id))
    .filter(Boolean) as RegexConfig[];

  const userIdentity = resolveUserIdentity(ownerType === "character" ? ownerId : undefined, "calendar");
  const character =
    ownerType === "character"
      ? loadCharacters().find(entry => entry.id === ownerId)
      : buildSyntheticUserCharacter(resolveUserIdentity(undefined, "calendar"));

  if (!character) {
    throw new Error("日历目标不存在。");
  }

  const memConfig = loadMemoryConfig();
  let coreMemories = "";
  let longTermMemories = "";
  let recentBlocks: import("./short-term-assembler").RecentBlock[] = [];
  let unifiedRecentItems: import("./short-term-assembler").UnifiedRecentItem[] = [];
  let wbActivationContext = "";

  if (ownerType === "character") {
    const prepared = prepareShortTermContext(ownerId, "calendar", { history: [] });
    recentBlocks = prepared.recentBlocks;
    unifiedRecentItems = prepared.unifiedRecentItems;
    wbActivationContext = prepared.wbActivationContext;
    const [coreResults, longResults] = await Promise.all([
      retrieveCoreMemoriesForPrompt(ownerId, memConfig).catch(() => []),
      retrieveMemoriesForPrompt(ownerId, wbActivationContext, memConfig).catch(() => []),
    ]);
    coreMemories = formatCoreMemories(coreResults);
    longTermMemories = formatLongTermMemories(longResults);
  }

  const scheduleSummary = buildCalendarScheduleMarker(ownerType, ownerId, weekStart);
  const llmMessages = assemblePromptPayload({
    character,
    history: [],
    preset,
    worldBooks,
    regexes,
    userIdentity,
    appId: "calendar",
    scheduleSummary,
    coreMemories,
    longTermMemories,
    worldBookActivationContext: wbActivationContext || undefined,
    recentBlocks,
    unifiedRecentItems,
    customStickerNames: ownerType === "character" ? getCustomStickerNames(ownerId) : "",
    customStickerExample: ownerType === "character" ? getCustomStickerExample(ownerId) : "",
  } as AssemblerInput);

  return {
    apiConfig,
    preset,
    regexes,
    llmMessages,
    ownerName: character.name,
  };
}

export async function generateWeeklyCalendarSchedule(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
): Promise<{ success: boolean; error?: string; items?: CalendarScheduleItem[] }> {
  if (ownerType !== "character") {
    return { success: false, error: "用户日程不支持 AI 生成，请手动填写。" };
  }
  // 先清掉本周旧的 AI 生成条目（保留手动条目），让随后的 marker 组装读不到旧结果——
  // 否则旧日程会进提示词被模型原样照抄，"重新生成"永远一字不差。失败时恢复。
  const removedGenerated = clearGeneratedWeekItems(ownerType, ownerId, weekStart);
  const restoreRemoved = () => restoreCalendarWeekItems(ownerType, ownerId, weekStart, removedGenerated);
  try {
    const resolved = await resolveCalendarAssemblerInput(ownerType, ownerId, weekStart);
    const weekDates = getWeekDates(weekStart);
    const triggerInstruction = buildCalendarTriggerInstruction(resolved.ownerName, weekDates);

    const messages: LLMMessage[] = [
      ...resolved.llmMessages,
      {
        role: "user",
        content: triggerInstruction,
        _debugMeta: { marker: "calendar_trigger" },
      },
    ];

    const rawText = await sendLLMRequest(
      resolved.apiConfig,
      resolved.preset,
      messages,
      resolved.regexes,
      { characterName: `日历:${resolved.ownerName}` },
      { appId: "calendar", appTags: ["calendar"] },
    );

    const items = parseScheduleLines(rawText, weekStart);
    if (items.length === 0) {
      restoreRemoved();
      return { success: false, error: "日历生成结果为空，或格式无法解析。" };
    }

    cloneWeekPlanWithManualEdits(ownerType, ownerId, weekStart, items);
    return { success: true, items };
  } catch (error) {
    restoreRemoved();
    const err = error as ChatEngineError | Error;
    return { success: false, error: err?.message || "生成日历失败" };
  }
}

export async function previewCalendarPromptPayload(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
  if (ownerType !== "character") {
    throw new Error("用户日程不支持 AI 生成预览。");
  }
  const resolved = await resolveCalendarAssemblerInput(ownerType, ownerId, weekStart);
  const weekDates = getWeekDates(weekStart);
  const triggerInstruction = buildCalendarTriggerInstruction(resolved.ownerName, weekDates);

  const messages: LLMMessage[] = [
    ...resolved.llmMessages,
    {
      role: "user",
      content: triggerInstruction,
      _debugMeta: { marker: "calendar_trigger" },
    },
  ];

  const apiMessages = previewMessagesForApi(resolved.apiConfig, resolved.preset, messages);
  return {
    messages: apiMessages,
    characterName: `日历:${resolved.ownerName}`,
    model: resolved.apiConfig.defaultModel,
    presetName: resolved.preset?.name ?? "(无预设)",
  };
}

export function createDefaultScheduleDraft(date: string) {
  return {
    date,
    weekday: getWeekdayLabel(date),
    startTime: "09:00",
    endTime: "10:00",
    location: "",
    title: "",
    emoji: "",
    source: "manual" as const,
  };
}

export function getCurrentWeekStart(): string {
  return getWeekStartIso(new Date());
}

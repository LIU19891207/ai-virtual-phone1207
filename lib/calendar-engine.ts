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
    "   - 事态属性：正务 或 闲娱（是否硬性必须落实）",
    "   - 时间跨度：短时 或 长程（【长程】必须跨越日期；一天内办结的必须是【短时】）",
    "   - 发生模式：临起 或 预筹（是否提前得知或具备心理预期）",
    "2. 标题要素精简与自然化：",
    "   - 出行方式：默认步行，步行时忽略不写；乘新干线、打车、公交等才注明工具及路线班次。",
    "   - 同行者：默认独行，独行时不写；有第二人及以上时自然表达（如“携团队”、“和B去游泳”），不写“与XX同行”。",
    "   - 地点：标题中只保留核心地点/地标（如“京都府厅”、“马尔利咖啡馆”）；详细层级地址（如“东京都｜涩谷区…｜1层”）写在地点字段中。",
    "   - 耗时：不直写入标题末尾，由模块起止时间体现。",
    "   - 示例：【正务/长程/预筹】携团队赴京都办理文旅产业联动共建项目备案公务",
    "3. 长程与短时层级（总分关系与独立打断）：",
    "   - 长程卡片下属的子事项（同一主题的推进阶段），直接以竖向子节点形式附在长程卡片内部，用换行加“•”组织，不单独生成小卡片。",
    "   - 若在长程跨度期间发生与长程截然不同的独立短时事项，长程在该时间段中断让位，生成独立短时卡片；短时结束后长程恢复。",
    "4. 输出格式（每行一条 Pipe 分隔，无 emoji）：",
    "   YYYY-MM-DD|开始时间|结束时间|详细地点|属性(正务/闲娱)|跨度(短时/长程)|模式(临起/预筹)|主标题|子节点列表(可选，多个用;;分隔，每个为 HH:MM 进展描述)",
    "   例如：",
    "   2023-09-12|13:00|21:00|京都府｜上京区薮之内町｜京都府厅|正务|长程|预筹|【正务/长程/预筹】携团队赴京都办理文旅产业联动共建项目备案公务|13:00 乘JR新干线721次由东京奔赴京都;;15:15 入住市内商务驻地，整理备案全套申报材料;;17:00 团队内部核对文书、磋商次日对接流程",
    "   2023-09-13|09:00|13:00|东京都｜涩谷区宇田川町4-26｜马尔利咖啡馆|正务|短时|临起|【正务/短时/临起】与合作方紧急会谈项目预算调整",
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

    let subNodes: import("./calendar-types").CalendarSubNode[] | undefined;

    if (parts.length >= 8) {
      date = parts[0];
      startTime = normalizeTime(parts[1]) || parts[1];
      endTime = normalizeTime(parts[2]) || parts[2];
      location = parts[3] === "无" ? "" : parts[3];
      attribute = (parts[4] === "正务" || parts[4] === "闲娱") ? parts[4] : undefined;
      span = (parts[5] === "短时" || parts[5] === "长程") ? parts[5] : undefined;
      mode = (parts[6] === "临起" || parts[6] === "预筹") ? parts[6] : undefined;
      title = parts[7];
      if (parts[8]) {
        const rawSub = parts.slice(8).join("|");
        subNodes = rawSub.split(";;").map(s => {
          const trimmed = s.trim().replace(/^[•\-\*]\s*/, "");
          const timeMatch = trimmed.match(/^(\d{1,2}:\d{2})\s*(.*)$/);
          if (timeMatch) {
            return { time: timeMatch[1], text: timeMatch[2] };
          }
          return { text: trimmed };
        }).filter(node => node.text);
      }
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
      subNodes,
      emoji,
    });
  }

  // 硬核归并机制：按日期收敛短时与长程
  const finalItems: typeof parsed = [];
  const dateGroups = new Map<string, typeof parsed>();
  for (const item of parsed) {
    const list = dateGroups.get(item.date) || [];
    list.push(item);
    dateGroups.set(item.date, list);
  }

  for (const [_, dayItems] of dateGroups.entries()) {
    const longItem = dayItems.find(i => i.span === "长程" || i.title.includes("长程"));
    if (!longItem) {
      finalItems.push(...dayItems);
      continue;
    }

    const mergedSubNodes = [...(longItem.subNodes || [])];
    const longStartMin = timeToMinutes(longItem.startTime);
    const longEndMin = timeToMinutes(longItem.endTime);

    for (const item of dayItems) {
      if (item === longItem) continue;
      const itemStartMin = timeToMinutes(item.startTime);
      const itemEndMin = timeToMinutes(item.endTime);

      // 只要处于长程时间范围内（无论是否标记为短时），除非它是跨天的新长程，否则一律强行合并为长程的内部 subNode！
      if (itemStartMin >= longStartMin && itemEndMin <= longEndMin && item.span !== "长程") {
        const cleanText = item.title.replace(/^【.*?】/, "").trim();
        mergedSubNodes.push({
          time: item.startTime,
          text: cleanText,
        });
      } else {
        finalItems.push(item);
      }
    }

    // 按时间点去重与升序排序
    const uniqueMap = new Map<string, string>();
    for (const sub of mergedSubNodes) {
      const key = `${sub.time || ""}_${sub.text}`;
      uniqueMap.set(key, sub.text);
    }
    longItem.subNodes = Array.from(uniqueMap.entries()).map(([k, text]) => {
      const time = k.split("_")[0];
      return { time: time || undefined, text };
    }).sort((a, b) => (a.time || "").localeCompare(b.time || ""));

    finalItems.push(longItem);
  }

  return normalizeGeneratedScheduleItems(finalItems);
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

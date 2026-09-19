"use client";

import { Check, ChevronLeft, Trash2 } from "lucide-react";
import { Input } from "../ui/form";
import type { CalendarColorKey } from "@/lib/calendar-types";
import { CALENDAR_COLOR_KEYS } from "@/lib/calendar-utils";

import type { CalendarScheduleAttribute, CalendarScheduleSpan, CalendarScheduleMode } from "@/lib/calendar-types";

export type CalendarEventDraft = {
  id?: string;
  date: string;
  /** 结束日期（含当天）；留空视为单天。跨多天时保存会按天生成日程 */
  endDate?: string;
  startTime: string;
  endTime: string;
  location: string;
  title: string;
  attribute?: CalendarScheduleAttribute;
  span?: CalendarScheduleSpan;
  mode?: CalendarScheduleMode;
  parentId?: string;
  emoji: string;
  colorKey?: CalendarColorKey;
};

const EMOJI_PRESETS = [
  "📌", "💼", "📚", "💻", "🏃", "🏋️", "🍽️", "☕", "🎬",
  "🎮", "🎵", "🛒", "🛍️", "✈️", "🏥", "📞", "💤", "❤️",
  "🎂", "🎨", "🧹", "🐾",
];

const COLOR_LABELS: Record<CalendarColorKey, string> = {
  blue: "蓝",
  green: "绿",
  amber: "橙",
  rose: "粉",
  violet: "紫",
  teal: "青",
  slate: "灰",
  lilac: "丁香",
};

export function CalendarEventEditModal({
  draft,
  onChange,
  onSave,
  onDelete,
  onClose,
}: {
  draft: CalendarEventDraft;
  onChange: (next: CalendarEventDraft) => void;
  onSave: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-overlay calendar-edit-modal-overlay" onClick={onClose}>
      <div className="calendar-edit-modal" data-ui="calendar-edit-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header" data-ui="modal-header">
          <button onClick={onClose} className="modal-header-btn modal-header-btn-muted" aria-label="返回">
            <ChevronLeft size={18} />
          </button>
          <span className="modal-header-title">{draft.id ? "编辑日程" : "新增日程"}</span>
          <button onClick={onSave} className="modal-header-btn modal-header-btn-action" aria-label="保存">
            <Check size={18} />
          </button>
        </div>

        <div className="modal-body hide-scrollbar flex flex-col gap-3 pb-10" data-ui="modal-body">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="menu-desc ml-1">开始日期</label>
              <Input
                type="date"
                value={draft.date}
                onChange={e => {
                  const nextDate = e.target.value;
                  const currentEnd = draft.endDate || draft.date;
                  // 结束日期跟随开始日期，除非用户已把结束日期改到更晚
                  onChange({ ...draft, date: nextDate, endDate: currentEnd > nextDate ? currentEnd : nextDate });
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="menu-desc ml-1">结束日期</label>
              <Input
                type="date"
                value={draft.endDate || draft.date}
                min={draft.date}
                onChange={e => onChange({ ...draft, endDate: e.target.value })}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="menu-desc ml-1">开始时间</label>
              <Input
                type="time"
                value={draft.startTime}
                onChange={e => onChange({ ...draft, startTime: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="menu-desc ml-1">结束时间</label>
              <Input
                type="time"
                value={draft.endTime}
                onChange={e => onChange({ ...draft, endTime: e.target.value })}
              />
            </div>
          </div>

          {/* 三组 2 选 1 标签 */}
          <div className="flex flex-col gap-2 p-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/5">
            <div className="text-xs font-medium text-black/60 dark:text-white/60 mb-0.5">日程标签属性</div>
            <div className="grid grid-cols-3 gap-2">
              <div className="flex flex-col gap-1">
                <span className="text-[11px] text-black/40 dark:text-white/40">事态属性</span>
                <div className="flex rounded-lg overflow-hidden border border-black/10 dark:border-white/10 p-0.5 bg-black/5 dark:bg-white/5">
                  {(["正务", "闲娱"] as const).map(attr => (
                    <button
                      key={attr}
                      type="button"
                      className={`flex-1 text-xs py-1 rounded-md transition-colors font-medium ${
                        (draft.attribute || "正务") === attr
                          ? "bg-white dark:bg-neutral-800 text-black dark:text-white shadow-sm"
                          : "text-black/50 dark:text-white/50"
                      }`}
                      onClick={() => onChange({ ...draft, attribute: attr })}
                    >
                      {attr}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[11px] text-black/40 dark:text-white/40">时间跨度</span>
                <div className="flex rounded-lg overflow-hidden border border-black/10 dark:border-white/10 p-0.5 bg-black/5 dark:bg-white/5">
                  {(["短时", "长程"] as const).map(span => (
                    <button
                      key={span}
                      type="button"
                      className={`flex-1 text-xs py-1 rounded-md transition-colors font-medium ${
                        (draft.span || "短时") === span
                          ? "bg-white dark:bg-neutral-800 text-black dark:text-white shadow-sm"
                          : "text-black/50 dark:text-white/50"
                      }`}
                      onClick={() => onChange({ ...draft, span: span })}
                    >
                      {span}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[11px] text-black/40 dark:text-white/40">发生模式</span>
                <div className="flex rounded-lg overflow-hidden border border-black/10 dark:border-white/10 p-0.5 bg-black/5 dark:bg-white/5">
                  {(["临起", "预筹"] as const).map(mode => (
                    <button
                      key={mode}
                      type="button"
                      className={`flex-1 text-xs py-1 rounded-md transition-colors font-medium ${
                        (draft.mode || "预筹") === mode
                          ? "bg-white dark:bg-neutral-800 text-black dark:text-white shadow-sm"
                          : "text-black/50 dark:text-white/50"
                      }`}
                      onClick={() => onChange({ ...draft, mode: mode })}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="menu-desc ml-1">事项标题</label>
            <Input
              value={draft.title}
              onChange={e => onChange({ ...draft, title: e.target.value })}
              placeholder="【正务/长程/预筹】乘JR新干线721次东京至京都，携团队前往..."
            />
            <span className="text-[11px] text-black/40 dark:text-white/40 ml-1">
              须包含出行方式、同行人、目的地、具体事项、预计耗时（短时精确到分）
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <label className="menu-desc ml-1">地点</label>
            <Input
              value={draft.location}
              onChange={e => onChange({ ...draft, location: e.target.value })}
              placeholder="例如：公司会议室 / 家里 / 商场"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="menu-desc ml-1">图标（点选，再点一次取消）</label>
            <div className="calendar-emoji-row">
              {draft.emoji && !EMOJI_PRESETS.includes(draft.emoji) ? (
                <button
                  type="button"
                  className="calendar-emoji-preset"
                  data-active="true"
                  onClick={() => onChange({ ...draft, emoji: "" })}
                  aria-label={`取消 ${draft.emoji}`}
                >
                  {draft.emoji}
                </button>
              ) : null}
              {EMOJI_PRESETS.map(emoji => (
                <button
                  key={emoji}
                  type="button"
                  className="calendar-emoji-preset"
                  data-active={draft.emoji === emoji ? "true" : undefined}
                  onClick={() => onChange({ ...draft, emoji: draft.emoji === emoji ? "" : emoji })}
                  aria-label={`使用 ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="menu-desc ml-1">颜色</label>
            <div className="calendar-color-picker">
              <button
                type="button"
                className="calendar-color-swatch calendar-color-swatch-auto"
                data-active={!draft.colorKey ? "true" : undefined}
                onClick={() => onChange({ ...draft, colorKey: undefined })}
              >
                自动
              </button>
              {CALENDAR_COLOR_KEYS.map(key => (
                <button
                  key={key}
                  type="button"
                  className="calendar-color-swatch"
                  data-color={key}
                  data-active={draft.colorKey === key ? "true" : undefined}
                  onClick={() => onChange({ ...draft, colorKey: key })}
                  aria-label={`颜色：${COLOR_LABELS[key]}`}
                  title={COLOR_LABELS[key]}
                />
              ))}
            </div>
          </div>

          {draft.id ? (
            <button type="button" className="ui-btn ui-btn-outline calendar-delete-btn" onClick={onDelete}>
              <Trash2 size={16} />
              删除该事项
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

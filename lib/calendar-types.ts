export type CalendarOwnerType = "user" | "character";

export type CalendarColorKey =
  | "blue"
  | "green"
  | "amber"
  | "rose"
  | "violet"
  | "teal"
  | "slate"
  | "lilac";

export type CalendarScheduleAttribute = "正务" | "闲娱";
export type CalendarScheduleSpan = "短时" | "长程";
export type CalendarScheduleMode = "临起" | "预筹";

export type CalendarSubNode = {
  time?: string;
  text: string;
};

export type CalendarScheduleItem = {
  id: string;
  date: string;       // YYYY-MM-DD
  weekday: string;    // 周一 ~ 周日
  startTime: string;  // HH:MM
  endTime: string;    // HH:MM
  location: string;
  title: string;
  /** 事态属性：正务/闲娱 */
  attribute?: CalendarScheduleAttribute;
  /** 时间跨度：短时/长程（长程必须跨越日期） */
  span?: CalendarScheduleSpan;
  /** 发生模式：临起/预筹 */
  mode?: CalendarScheduleMode;
  /** 关联的长程日程 ID（短时日程归属于长程时使用） */
  parentId?: string;
  /** 长程卡片内部竖向子节点（• 时间段/阶段进展） */
  subNodes?: CalendarSubNode[];
  /** 事项 emoji 图标（可选，一个 emoji） */
  emoji?: string;
  colorKey: CalendarColorKey;
  source: "manual" | "generated";
  createdAt: string;
  updatedAt: string;
};

export type CalendarWeekPlan = {
  id: string;
  ownerType: CalendarOwnerType;
  ownerId: string;
  weekStart: string; // YYYY-MM-DD, Monday
  items: CalendarScheduleItem[];
  updatedAt: string;
};

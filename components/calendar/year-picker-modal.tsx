"use client";

import { useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";

export function CalendarYearPickerModal({
  currentYear,
  onSave,
  onClose,
}: {
  currentYear: number;
  onSave: (year: number) => void;
  onClose: () => void;
}) {
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const containerRef = useRef<HTMLDivElement>(null);

  // 生成从 1900 年到 2100 年的年份列表
  const years = Array.from({ length: 201 }, (_, i) => 1900 + i);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const activeItem = el.querySelector<HTMLElement>(`[data-year="${selectedYear}"]`);
    if (activeItem) {
      el.scrollTop = activeItem.offsetTop - el.clientHeight / 2 + activeItem.clientHeight / 2;
    }
  }, []);

  return (
    <div className="modal-overlay calendar-edit-modal-overlay" onClick={onClose}>
      <div className="calendar-edit-modal calendar-year-picker-modal" onClick={e => e.stopPropagation()}>
        <div className="calendar-theme-modal-head">
          <strong>设置历法年份</strong>
          <button type="button" onClick={onClose} className="calendar-icon-btn" aria-label="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="calendar-year-scroll-container hide-scrollbar" ref={containerRef}>
          <div className="calendar-year-scroll-spacer" />
          {years.map(y => (
            <button
              key={y}
              type="button"
              data-year={y}
              className={`calendar-year-picker-item ${y === selectedYear ? "is-selected" : ""}`}
              onClick={() => setSelectedYear(y)}
            >
              {y} 年
            </button>
          ))}
          <div className="calendar-year-scroll-spacer" />
        </div>

        <div className="calendar-year-picker-footer">
          <button type="button" className="calendar-block-btn" data-variant="ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="calendar-block-btn" data-variant="primary" onClick={() => onSave(selectedYear)}>
            <Check size={16} />
            保存设置
          </button>
        </div>
      </div>
    </div>
  );
}

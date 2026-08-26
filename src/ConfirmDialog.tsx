import { useEffect, useId } from "react";
import type { ReactNode } from "react";

interface ConfirmDialogProps {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  icon?: ReactNode;
  onConfirm(): void;
  onCancel(): void;
}

/**
 * Nebula 对照实现（issue #64 / v1.3.1 弹窗取消一致性）：
 * - Esc、点击遮罩空白处、取消按钮三条路径行为一致，都执行 onCancel；
 * - 确认按钮独立触发 onConfirm，危险操作带 danger 样式与图标；
 * - 默认焦点落在取消按钮，防止误触确认。
 */
export default function ConfirmDialog({ title, body, confirmLabel, cancelLabel, danger, icon, onConfirm, onCancel }: ConfirmDialogProps) {
  const titleId = useId();
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onCancel]);
  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className={"confirm-dialog" + (danger ? " danger" : "")}>
        {icon && <div className="confirm-dialog-icon">{icon}</div>}
        <h2 id={titleId}>{title}</h2>
        {body && <div className="confirm-dialog-body">{body}</div>}
        <div className="dialog-actions">
          <button type="button" autoFocus onClick={onCancel}>{cancelLabel}</button>
          <button type="button" className={danger ? "danger-confirm" : "primary-confirm"} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

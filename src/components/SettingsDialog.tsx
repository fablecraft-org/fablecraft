import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { OverlayShell } from "./OverlayShell";
import { useSettingsStore } from "../state/settingsStore";

interface SettingsDialogProps {
  onClose: () => void;
}

const SETTING_ROW_COUNT = 6;

function SettingGroup<T extends string>({
  active,
  id,
  label,
  options,
  onChange,
  onFocusNext,
  onFocused,
  onFocusPrevious,
  rowRef,
  value,
}: {
  active: boolean;
  id: string;
  label: string;
  onChange: (value: T) => void;
  options: Array<{
    label: string;
    value: T;
  }>;
  onFocusNext: () => void;
  onFocused: () => void;
  onFocusPrevious: () => void;
  rowRef: (element: HTMLElement | null) => void;
  value: T;
}) {
  const labelId = useId();
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  function handleRowKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const movePrevious = event.key === "ArrowLeft";
    const moveNext = event.key === "ArrowRight";
    const moveRowPrevious = event.key === "ArrowUp";
    const moveRowNext = event.key === "ArrowDown";
    const moveHome = event.key === "Home";
    const moveEnd = event.key === "End";

    if (moveRowPrevious || moveRowNext) {
      event.preventDefault();
      event.stopPropagation();

      if (moveRowPrevious) {
        onFocusPrevious();
      } else {
        onFocusNext();
      }

      return;
    }

    if (!movePrevious && !moveNext && !moveHome && !moveEnd) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const nextIndex = moveHome
      ? 0
      : moveEnd
        ? options.length - 1
        : movePrevious
          ? Math.max(0, selectedIndex - 1)
          : Math.min(options.length - 1, selectedIndex + 1);

    onChange(options[nextIndex]!.value);
  }

  return (
    <section
      aria-labelledby={labelId}
      className="group bg-[var(--fc-color-surface-strong)] px-5 py-4 shadow-[var(--fc-shadow-soft)] outline-none transition duration-[var(--fc-animation-ms)] ease-[var(--fc-animation-easing)] focus:shadow-[var(--fc-shadow-elevated)] focus-visible:shadow-[var(--fc-shadow-elevated)]"
      data-active={active ? "true" : "false"}
      data-testid={`setting-row-${id}`}
      onClickCapture={(event) => {
        event.currentTarget.focus();
      }}
      onFocus={onFocused}
      onKeyDown={handleRowKeyDown}
      ref={rowRef}
      tabIndex={0}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-flex w-3 justify-center font-[var(--fc-font-ui)] text-xs font-semibold text-[var(--fc-color-text)] transition duration-[var(--fc-animation-ms)] ease-[var(--fc-animation-easing)]"
            data-testid={`setting-row-${id}-chevron`}
            style={{ opacity: active ? 1 : 0 }}
          >
            &gt;
          </span>
          <div
            className="font-[var(--fc-font-ui)] text-xs uppercase tracking-[0.18em] text-[var(--fc-color-muted)]"
            id={labelId}
          >
            {label}
          </div>
        </div>
        <div
          className="inline-flex min-w-[320px] items-center rounded-full p-1"
          style={{ boxShadow: "inset 0 0 0 1.5px rgba(23, 20, 18, 0.16)" }}
        >
          {options.map((option, index) => (
            <Fragment key={option.value}>
              <button
                aria-pressed={option.value === value}
                className="flex flex-1 items-center justify-center px-4 py-2.5"
                onClick={() => onChange(option.value)}
                onMouseDown={(event) => event.preventDefault()}
                tabIndex={-1}
                type="button"
              >
                <span
                  className="text-[length:var(--fc-content-size)] leading-[1.3] transition duration-[var(--fc-animation-ms)] ease-[var(--fc-animation-easing)]"
                  style={{
                    color: option.value === value
                      ? "var(--fc-color-text)"
                      : "var(--fc-color-muted)",
                  }}
                >
                  {option.label}
                </span>
              </button>

              {index === 0 && (
                <span
                  aria-hidden="true"
                  className="relative inline-flex h-8 w-[58px] shrink-0 items-center rounded-full"
                  style={{ boxShadow: "inset 0 0 0 2px var(--fc-color-text)" }}
                >
                  <span
                    className="absolute h-3.5 w-[2px] rounded-full bg-[var(--fc-color-text)]"
                    style={{
                      left: selectedIndex === 0 ? "42px" : "12px",
                      transition: "left var(--fc-animation-ms) var(--fc-animation-easing)",
                    }}
                  />
                  <span
                    className="absolute h-3.5 w-3.5 rounded-full bg-[var(--fc-color-text)]"
                    style={{
                      left: selectedIndex === 0 ? "10px" : "36px",
                      transition: "left var(--fc-animation-ms) var(--fc-animation-easing)",
                    }}
                  />
                </span>
              )}
            </Fragment>
          ))}
        </div>
      </div>
    </section>
  );
}

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const activeRowIndexRef = useRef(0);
  const rowRefs = useRef<Array<HTMLElement | null>>([]);
  const [activeRowIndex, setActiveRowIndex] = useState(0);
  const preferences = useSettingsStore((state) => state.preferences);
  const resetPreferences = useSettingsStore((state) => state.resetPreferences);
  const setCardWidth = useSettingsStore((state) => state.setCardWidth);
  const setFont = useSettingsStore((state) => state.setFont);
  const setLineHeight = useSettingsStore((state) => state.setLineHeight);
  const setScrollPan = useSettingsStore((state) => state.setScrollPan);
  const setTextSize = useSettingsStore((state) => state.setTextSize);
  const setTheme = useSettingsStore((state) => state.setTheme);

  const focusRow = useCallback((index: number) => {
    const nextIndex = (index + SETTING_ROW_COUNT) % SETTING_ROW_COUNT;
    activeRowIndexRef.current = nextIndex;
    setActiveRowIndex(nextIndex);
    rowRefs.current[nextIndex]?.focus();
  }, []);

  useEffect(() => {
    focusRow(activeRowIndexRef.current);
  }, [focusRow]);

  useLayoutEffect(() => {
    focusRow(activeRowIndexRef.current);
  }, [focusRow, preferences]);

  return (
    <OverlayShell
      footer="These controls update the global UI tokens immediately for the current machine."
      onPanelKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }

        event.stopPropagation();
      }}
      title="Settings"
      widthClassName="max-w-[min(92vw,760px)]"
    >
      <div className="flex flex-col gap-3">
        <SettingGroup
          active={activeRowIndex === 0}
          id="theme"
          label="Theme"
          onChange={setTheme}
          onFocused={() => {
            activeRowIndexRef.current = 0;
            setActiveRowIndex(0);
          }}
          onFocusNext={() => focusRow(1)}
          onFocusPrevious={() => focusRow(-1)}
          options={[
            { label: "Light", value: "light" },
            { label: "Dark", value: "dark" },
          ]}
          rowRef={(element) => {
            rowRefs.current[0] = element;
          }}
          value={preferences.theme}
        />
        <SettingGroup
          active={activeRowIndex === 1}
          id="font"
          label="Font"
          onChange={setFont}
          onFocused={() => {
            activeRowIndexRef.current = 1;
            setActiveRowIndex(1);
          }}
          onFocusNext={() => focusRow(2)}
          onFocusPrevious={() => focusRow(0)}
          options={[
            { label: "Serif", value: "serif" },
            { label: "Sans", value: "sans" },
          ]}
          rowRef={(element) => {
            rowRefs.current[1] = element;
          }}
          value={preferences.font}
        />
        <SettingGroup
          active={activeRowIndex === 2}
          id="text-size"
          label="Text Size"
          onChange={setTextSize}
          onFocused={() => {
            activeRowIndexRef.current = 2;
            setActiveRowIndex(2);
          }}
          onFocusNext={() => focusRow(3)}
          onFocusPrevious={() => focusRow(1)}
          options={[
            { label: "Comfortable", value: "comfortable" },
            { label: "Large", value: "large" },
          ]}
          rowRef={(element) => {
            rowRefs.current[2] = element;
          }}
          value={preferences.textSize}
        />
        <SettingGroup
          active={activeRowIndex === 3}
          id="line-height"
          label="Line Height"
          onChange={setLineHeight}
          onFocused={() => {
            activeRowIndexRef.current = 3;
            setActiveRowIndex(3);
          }}
          onFocusNext={() => focusRow(4)}
          onFocusPrevious={() => focusRow(2)}
          options={[
            { label: "Compact", value: "compact" },
            { label: "Relaxed", value: "relaxed" },
          ]}
          rowRef={(element) => {
            rowRefs.current[3] = element;
          }}
          value={preferences.lineHeight}
        />
        <SettingGroup
          active={activeRowIndex === 4}
          id="card-width"
          label="Card Width"
          onChange={setCardWidth}
          onFocused={() => {
            activeRowIndexRef.current = 4;
            setActiveRowIndex(4);
          }}
          onFocusNext={() => focusRow(5)}
          onFocusPrevious={() => focusRow(3)}
          options={[
            { label: "Standard", value: "standard" },
            { label: "Wide", value: "wide" },
          ]}
          rowRef={(element) => {
            rowRefs.current[4] = element;
          }}
          value={preferences.cardWidth}
        />
        <SettingGroup
          active={activeRowIndex === 5}
          id="scroll-pan"
          label="Trackpad Pan"
          onChange={setScrollPan}
          onFocused={() => {
            activeRowIndexRef.current = 5;
            setActiveRowIndex(5);
          }}
          onFocusNext={() => focusRow(0)}
          onFocusPrevious={() => focusRow(4)}
          options={[
            { label: "Enabled", value: "enabled" },
            { label: "Disabled", value: "disabled" },
          ]}
          rowRef={(element) => {
            rowRefs.current[5] = element;
          }}
          value={preferences.scrollPan}
        />
      </div>

      <div className="mt-6 flex items-center justify-between gap-3">
        <button
          className="rounded-full px-4 py-2 font-[var(--fc-font-ui)] text-sm text-[var(--fc-color-text)] shadow-[inset_0_0_0_1.5px_rgba(23,20,18,0.16)] transition duration-[var(--fc-animation-ms)] ease-[var(--fc-animation-easing)] hover:shadow-[inset_0_0_0_1.5px_rgba(23,20,18,0.32)]"
          onClick={resetPreferences}
          type="button"
        >
          Reset
        </button>

        <button
          className="rounded-full bg-[var(--fc-color-text)] px-4 py-2 font-[var(--fc-font-ui)] text-sm text-[var(--fc-color-on-dark)] shadow-[var(--fc-shadow-soft)] transition duration-[var(--fc-animation-ms)] ease-[var(--fc-animation-easing)] hover:-translate-y-[1px]"
          onClick={onClose}
          type="button"
        >
          Close
        </button>
      </div>
    </OverlayShell>
  );
}

"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DayPicker, type ChevronProps } from "react-day-picker";
import "react-day-picker/style.css";

import { cn } from "@/app/lib/utils";

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

function CalendarChevron({ orientation, className }: ChevronProps) {
  return orientation === "left" ? (
    <ChevronLeft className={cn("size-4", className)} />
  ) : (
    <ChevronRight className={cn("size-4", className)} />
  );
}

/*
 * Lab/instrument calendar — sharp 0px corners, hairline rules, plot-red selection.
 * Wraps react-day-picker; only the slot classNames + Chevron component are
 * customized so the lib's built-in CSS still drives layout.
 */
export function Calendar({ className, classNames, components, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays
      className={cn("p-3", className)}
      classNames={{
        months: "flex flex-col gap-4",
        month: "flex flex-col gap-3",
        month_caption: "flex h-8 items-center justify-center px-8",
        caption_label:
          "font-mono text-[12px] uppercase tracking-[0.08em] text-ink",
        nav: "absolute right-3 top-3 flex items-center gap-1",
        button_previous:
          "inline-flex size-7 items-center justify-center border border-paper-rule bg-paper text-ink-soft transition-colors hover:bg-paper-sunk hover:text-ink disabled:pointer-events-none disabled:opacity-40",
        button_next:
          "inline-flex size-7 items-center justify-center border border-paper-rule bg-paper text-ink-soft transition-colors hover:bg-paper-sunk hover:text-ink disabled:pointer-events-none disabled:opacity-40",
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday:
          "flex w-9 items-center justify-center font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint",
        week: "mt-1 flex w-full",
        day: "relative size-9 p-0 text-center text-sm",
        day_button:
          "inline-flex size-9 items-center justify-center text-sm tabular-nums text-ink-soft transition-colors hover:bg-paper-sunk hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-plot-red",
        selected: "[&>button]:bg-ink [&>button]:text-paper [&>button:hover]:bg-ink",
        today: "[&>button]:text-plot-red [&>button]:font-semibold",
        outside: "[&>button]:text-ink-faint",
        disabled: "[&>button]:opacity-30 [&>button]:pointer-events-none",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: CalendarChevron,
        ...components,
      }}
      {...props}
    />
  );
}

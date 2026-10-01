import type { ReactElement } from "react";
import type { CreatorInfo } from "../../lib/feed";

interface CreatorChipProps {
  readonly creator: CreatorInfo;
}

function initialsOf(name: string): string {
  const parts: string[] = name.trim().split(/\s+/).filter((part: string) => part.length > 0);
  if (parts.length === 0) return "H";
  const first: string = parts[0]?.charAt(0) ?? "H";
  const second: string = parts.length > 1 ? (parts[1]?.charAt(0) ?? "") : "";
  return `${first}${second}`.toUpperCase();
}

/** Avatar + display name row shown at the bottom of every Hustle Card. */
export default function CreatorChip({ creator }: CreatorChipProps): ReactElement {
  return (
    <div className="flex items-center gap-2.5">
      {creator.avatarUrl !== null ? (
        <img
          src={creator.avatarUrl}
          alt={`${creator.displayName} avatar`}
          loading="lazy"
          className="h-8 w-8 rounded-full border border-white/10 object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-indigoGlow/40 to-violetGlow/40 text-xs font-bold text-white ring-1 ring-white/10"
        >
          {initialsOf(creator.displayName)}
        </span>
      )}
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-slate-200">{creator.displayName}</p>
        <p className="text-[11px] text-slate-500">Creator</p>
      </div>
    </div>
  );
}

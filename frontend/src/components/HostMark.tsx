/**
 * HostMark.tsx
 * ------------
 * The small service-bell mark used for Table Tonight in the header
 * and beside each of Host's messages.
 */
interface Props {
  small?: boolean;
}

export function HostMark({ small = false }: Props) {
  return (
    <div className={small ? "agent-avatar agent-avatar-sm" : "agent-avatar"} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none">
        <path d="M4.5 17.5h15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M7 17.5a5 5 0 0 0 10 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M12 7.2V5.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="12" cy="4" r="1.15" fill="currentColor" />
      </svg>
    </div>
  );
}

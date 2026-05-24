interface SearchBoxProps {
  value: string;
  onChange: (value: string) => void;
}

export function SearchBox({ value, onChange }: SearchBoxProps) {
  return (
    <label className="cqn-search">
      <span className="cqn-search-icon">⌕</span>
      <input
        value={value}
        onInput={(event) => onChange(event.currentTarget.value)}
        placeholder="搜索问题"
        type="search"
      />
    </label>
  );
}

const S = (p: { d: string; size?: number; fill?: boolean }) => (
  <svg width={p.size ?? 14} height={p.size ?? 14} viewBox="0 0 16 16" aria-hidden>
    <path d={p.d} fill={p.fill ? 'currentColor' : 'none'} stroke={p.fill ? 'none' : 'currentColor'} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconPlay = () => <S fill d="M4 2.5v11l9.5-5.5z" />;
export const IconPause = () => <S fill d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z" />;
export const IconStop = () => <S fill d="M3 3h10v10H3z" />;
export const IconRecord = () => <S fill d="M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11z" />;
export const IconPlus = () => <S d="M8 3v10M3 8h10" />;
export const IconPencil = () => <S d="M3 13l1-3.5 7-7 2.5 2.5-7 7zM10 4l2 2" />;
export const IconSelect = () => <S d="M3 2l9 5-4 1.2L6.5 12z" />;
export const IconErase = () => <S d="M6 13h7M3.5 9.5l5-5 3.5 3.5-5 5H5z" />;
export const IconBrush = () => <S d="M10 2l4 4-6 6-4-4zM4 8l-2 6 6-2" />;
export const IconSlice = () => <S d="M8 1v14M5 4l3-3 3 3M5 12l3 3 3-3" />;
export const IconMetronome = () => <S d="M5 14l2.5-12h1L11 14zM8 10l4-6" />;
export const IconLoop = () => <S d="M3 7a4 4 0 0 1 4-4h5l-2-2M13 9a4 4 0 0 1-4 4H4l2 2" />;
export const IconFollow = () => <S d="M2 8h9M8 4l4 4-4 4M14 2v12" />;
export const IconMagnet = () => <S d="M4 2v6a4 4 0 0 0 8 0V2M4 5h3M9 5h3" />;
export const IconKeyboard = () => <S d="M1.5 4h13v8h-13zM4 7h1M7 7h1M10 7h1M4.5 10h7" />;
export const IconMidi = () => <S d="M8 1.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13zM5 8h.01M11 8h.01M8 5h.01M6 5.8h.01M10 5.8h.01" />;
export const IconCode = () => <S d="M5.5 4L2 8l3.5 4M10.5 4L14 8l-3.5 4" />;
export const IconPlaylist = () => <S d="M2 3h12M2 8h12M2 13h12M5 3v10" />;
export const IconRack = () => <S d="M2 3h12v10H2zM2 6.5h12M2 10h12M5 3v10" />;
export const IconPiano = () => <S d="M2 3h12v10H2zM5 3v6M8 3v10M11 3v6" />;
export const IconMixer = () => <S d="M4 2v12M8 2v12M12 2v12M2.5 10h3M6.5 5h3M10.5 8h3" />;
export const IconPlug = () => <S d="M6 1v4M10 1v4M4 5h8v3a4 4 0 0 1-8 0zM8 12v3" />;
export const IconHelp = () => <S d="M6 6a2 2 0 1 1 3 1.7c-.7.4-1 .8-1 1.6M8 12h.01" />;
export const IconUndo = () => <S d="M5 3L2 6l3 3M2 6h7a4 4 0 0 1 0 8H6" />;
export const IconRedo = () => <S d="M11 3l3 3-3 3M14 6H7a4 4 0 0 0 0 8h3" />;
export const IconSave = () => <S d="M3 2h8l2 2v10H3zM5 2v4h5V2M5 14v-4h6v4" />;
export const IconOpen = () => <S d="M2 4h4l1.5 1.5H14V13H2z" />;
export const IconExport = () => <S d="M8 2v8M5 5l3-3 3 3M3 10v4h10v-4" />;
export const IconTrash = () => <S d="M3 4h10M6 4V2.5h4V4M4.5 4l.7 10h5.6l.7-10" />;
export const IconAuto = () => <S d="M1.5 12L5 6l3 4 3.5-7 3 5" />;
export const IconSettings = () => <S d="M8 5.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5zM8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3" />;

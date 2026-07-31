declare module "lucide-react-native" {
  import type React from "react";
  import type { SvgProps } from "react-native-svg";

  export type LucideProps = SvgProps & {
    size?: number | string;
    absoluteStrokeWidth?: boolean;
  };
  export type LucideIcon = React.ComponentType<LucideProps>;

  export const ArrowDownLeft: LucideIcon;
  export const ArrowLeftRight: LucideIcon;
  export const Banknote: LucideIcon;
  export const BarChart2: LucideIcon;
  export const BookOpen: LucideIcon;
  export const Calendar: LucideIcon;
  export const Cube: LucideIcon;
  export const Box: LucideIcon;
  export const FileText: LucideIcon;
  export const Mic: LucideIcon;
  export const Package: LucideIcon;
  export const PieChart: LucideIcon;
  export const Receipt: LucideIcon;
  export const Sparkles: LucideIcon;
  export const Tag: LucideIcon;
  export const TrendingUp: LucideIcon;
  export const Wallet: LucideIcon;
}

declare module "lucide-react-native/icons/*" {
  import type { LucideIcon } from "lucide-react-native";
  const Icon: LucideIcon;
  export default Icon;
}
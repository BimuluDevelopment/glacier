import {
  Activity,
  BookOpen,
  Clock,
  Cloud,
  Cpu,
  Database,
  Gamepad2,
  Gauge,
  Globe,
  HardDrive,
  Headphones,
  Heart,
  Home,
  Link as LinkIcon,
  Lock,
  MessageCircle,
  Rocket,
  Server,
  Shield,
  Sparkles,
  Star,
  Users,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { LANDING_ICONS } from '@glacier/shared';

export const ICONS: Record<(typeof LANDING_ICONS)[number], LucideIcon> = {
  zap: Zap,
  shield: Shield,
  cpu: Cpu,
  globe: Globe,
  clock: Clock,
  headphones: Headphones,
  database: Database,
  server: Server,
  sparkles: Sparkles,
  gauge: Gauge,
  lock: Lock,
  cloud: Cloud,
  rocket: Rocket,
  heart: Heart,
  star: Star,
  users: Users,
  gamepad: Gamepad2,
  wrench: Wrench,
  'hard-drive': HardDrive,
  activity: Activity,
  message: MessageCircle,
  book: BookOpen,
  home: Home,
  link: LinkIcon,
};

export function Icon({ name, className }: { name?: keyof typeof ICONS; className?: string }) {
  if (!name) return null;
  const Component = ICONS[name];
  return Component ? <Component className={className} /> : null;
}

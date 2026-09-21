/**
 * 共享类型定义：与 Rust 主进程 config.rs 中的结构保持一致
 */

export type Quality = 'high' | 'medium' | 'low';

export type FishSpecies = 'clownfish' | 'guppy' | 'goldfish';

export interface Config {
  fishCount: number;
  fishSpecies: FishSpecies[];
  speed: number;
  plantDensity: number;
  quality: Quality;
  fps: number;
  multiMonitor: boolean;
  autoStart: boolean;
  pauseOnFullscreen: boolean;
  interactiveMode: boolean;
  sound: boolean;
}

export const DEFAULT_CONFIG: Config = {
  fishCount: 8,
  fishSpecies: ['clownfish', 'guppy', 'goldfish'],
  speed: 1.0,
  plantDensity: 0.7,
  quality: 'high',
  fps: 60,
  multiMonitor: true,
  autoStart: true,
  pauseOnFullscreen: true,
  interactiveMode: false,
  sound: false,
};

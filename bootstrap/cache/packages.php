<?php return array (
  'laravel/tinker' => 
  array (
    'providers' => 
    array (
      0 => 'Laravel\\Tinker\\TinkerServiceProvider',
    ),
  ),
  'nativephp/electron' => 
  array (
    'aliases' => 
    array (
      'Updater' => 'Native\\Electron\\Facades\\Updater',
    ),
    'providers' => 
    array (
      0 => 'Native\\Electron\\ElectronServiceProvider',
    ),
  ),
  'nativephp/laravel' => 
  array (
    'aliases' => 
    array (
      'Dock' => 'Native\\Laravel\\Facades\\Dock',
      'Menu' => 'Native\\Laravel\\Facades\\Menu',
      'Shell' => 'Native\\Laravel\\Facades\\Shell',
      'Screen' => 'Native\\Laravel\\Facades\\Screen',
      'System' => 'Native\\Laravel\\Facades\\System',
      'Window' => 'Native\\Laravel\\Facades\\Window',
      'MenuBar' => 'Native\\Laravel\\Facades\\MenuBar',
      'Process' => 'Native\\Laravel\\Facades\\Process',
      'Settings' => 'Native\\Laravel\\Facades\\Settings',
      'Clipboard' => 'Native\\Laravel\\Facades\\Clipboard',
      'ContextMenu' => 'Native\\Laravel\\Facades\\ContextMenu',
      'QueueWorker' => 'Native\\Laravel\\Facades\\QueueWorker',
      'ChildProcess' => 'Native\\Laravel\\Facades\\ChildProcess',
      'Notification' => 'Native\\Laravel\\Facades\\Notification',
      'PowerMonitor' => 'Native\\Laravel\\Facades\\PowerMonitor',
      'GlobalShortcut' => 'Native\\Laravel\\Facades\\GlobalShortcut',
    ),
    'providers' => 
    array (
      0 => 'Native\\Laravel\\NativeServiceProvider',
    ),
  ),
  'nesbot/carbon' => 
  array (
    'providers' => 
    array (
      0 => 'Carbon\\Laravel\\ServiceProvider',
    ),
  ),
  'nunomaduro/collision' => 
  array (
    'providers' => 
    array (
      0 => 'NunoMaduro\\Collision\\Adapters\\Laravel\\CollisionServiceProvider',
    ),
  ),
  'nunomaduro/termwind' => 
  array (
    'providers' => 
    array (
      0 => 'Termwind\\Laravel\\TermwindServiceProvider',
    ),
  ),
);
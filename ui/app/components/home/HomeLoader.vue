<template>
  <div class="min-h-screen flex flex-col items-center justify-center bg-base-50 px-4">
    <div class="flex flex-col items-center text-center max-w-md">

      <!-- Анимированная иллюстрация: товары → обработка → сделка -->
      <svg
        class="w-40 h-40 sm:w-48 sm:h-48"
        viewBox="0 0 200 200"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="Загрузка"
      >
        <!-- Земля / линия логистики -->
        <line
          x1="20" y1="150" x2="180" y2="150"
          stroke="currentColor"
          class="text-base-300"
          stroke-width="2"
          stroke-dasharray="6 8"
          stroke-linecap="round"
        >
          <animate
            attributeName="stroke-dashoffset"
            from="28" to="0"
            dur="1.2s"
            repeatCount="indefinite"
          />
        </line>

        <!-- Грузовик (едет туда-сюда) -->
        <g class="text-air-primary" style="color: var(--ui-color-accent-main-primary, #2563eb)">
          <animateTransform
            attributeName="transform"
            type="translate"
            values="0 0; 14 0; 0 0"
            dur="2.4s"
            repeatCount="indefinite"
            calcMode="spline"
            keySplines="0.4 0 0.2 1; 0.4 0 0.2 1"
          />
          <!-- кузов -->
          <rect x="38" y="118" width="34" height="24" rx="3" fill="currentColor" opacity="0.9" />
          <!-- кабина -->
          <path d="M72 124 h14 l8 10 v8 h-22 z" fill="currentColor" opacity="0.7" />
          <!-- колёса -->
          <circle cx="50" cy="146" r="5" fill="currentColor" />
          <circle cx="84" cy="146" r="5" fill="currentColor" />
          <circle cx="50" cy="146" r="2" class="text-base-50" fill="var(--ui-color-base-50, #f1f5f9)" />
          <circle cx="84" cy="146" r="2" fill="var(--ui-color-base-50, #f1f5f9)" />
        </g>

        <!-- Коробки товаров (появляются по очереди) -->
        <g class="text-base-400" fill="currentColor">
          <rect x="116" y="116" width="26" height="26" rx="3" opacity="0.85">
            <animate attributeName="y" values="116;110;116" dur="1.6s" repeatCount="indefinite" begin="0s" />
            <animate attributeName="opacity" values="0.4;0.9;0.4" dur="1.6s" repeatCount="indefinite" begin="0s" />
          </rect>
          <rect x="146" y="116" width="26" height="26" rx="3" opacity="0.7">
            <animate attributeName="y" values="116;110;116" dur="1.6s" repeatCount="indefinite" begin="0.3s" />
            <animate attributeName="opacity" values="0.4;0.9;0.4" dur="1.6s" repeatCount="indefinite" begin="0.3s" />
          </rect>
          <rect x="131" y="88" width="26" height="26" rx="3" opacity="0.6">
            <animate attributeName="y" values="88;82;88" dur="1.6s" repeatCount="indefinite" begin="0.6s" />
            <animate attributeName="opacity" values="0.3;0.8;0.3" dur="1.6s" repeatCount="indefinite" begin="0.6s" />
          </rect>
          <!-- скотч-линии на коробках -->
          <line x1="129" y1="116" x2="129" y2="142" stroke="var(--ui-color-base-50, #f1f5f9)" stroke-width="2" />
          <line x1="159" y1="116" x2="159" y2="142" stroke="var(--ui-color-base-50, #f1f5f9)" stroke-width="2" />
        </g>

        <!-- Галочка-сделка (пульсирует над коробками) -->
        <g style="color: var(--ui-color-accent-main-success, #16a34a)">
          <circle cx="144" cy="58" r="13" fill="currentColor" opacity="0.15">
            <animate attributeName="r" values="11;14;11" dur="1.8s" repeatCount="indefinite" />
          </circle>
          <path
            d="M138 58 l4 4 l8 -8"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            fill="none"
          >
            <animate attributeName="opacity" values="0.4;1;0.4" dur="1.8s" repeatCount="indefinite" />
          </path>
        </g>
      </svg>

      <h1 class="mt-6 text-xl font-semibold text-base-master">
        Procure AI
      </h1>
      <p class="mt-1.5 text-sm text-base-500">
        Готовим загрузку прайс-листов…
      </p>

      <!-- Тонкий прогресс -->
      <div class="mt-5 w-40">
        <B24Progress :model-value="null" animation="carousel" color="air-primary" size="xs" />
      </div>

    </div>
  </div>
</template>

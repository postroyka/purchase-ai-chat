<template>
  <div class="min-h-screen flex flex-col items-center justify-center bg-base-50 px-4">
    <div class="flex flex-col items-center text-center max-w-md">
      <!-- Фирменный грузовик postroyka.by едет по дороге -->
      <svg
        class="w-48 h-44 sm:w-56 sm:h-52"
        viewBox="0 0 110 96"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="Загрузка"
      >
        <!-- Дорога -->
        <line
          x1="6"
          y1="90"
          x2="104"
          y2="90"
          stroke="currentColor"
          class="text-base-300"
          stroke-width="2"
          stroke-dasharray="7 9"
          stroke-linecap="round"
        >
          <animate
            attributeName="stroke-dashoffset"
            from="32"
            to="0"
            dur="0.9s"
            repeatCount="indefinite"
          />
        </line>

        <!-- Грузовик: лёгкое покачивание на ходу + общий проезд туда-сюда -->
        <g>
          <animateTransform
            attributeName="transform"
            type="translate"
            values="10 8; 22 8; 10 8"
            dur="3s"
            repeatCount="indefinite"
            calcMode="spline"
            keySplines="0.45 0 0.2 1; 0.45 0 0.2 1"
            additive="sum"
          />
          <animateTransform
            attributeName="transform"
            type="translate"
            values="0 0; 0 -1; 0 0; 0 -0.6; 0 0"
            dur="0.5s"
            repeatCount="indefinite"
            additive="sum"
          />

          <path
            fill-rule="evenodd"
            clip-rule="evenodd"
            d="M55.5107 44.3541C55.5913 43.8077 56.0995 43.4301 56.6459 43.5107L80.2918 46.9984C81.2731 47.1431 82 47.9851 82 48.977V68C82 68.5523 81.5523 69 81 69H55.5C54.9477 69 54.5 68.5523 54.5 68C54.5 67.4477 54.9477 67 55.5 67H80L80 48.977L56.3541 45.4893C55.8077 45.4087 55.4301 44.9005 55.5107 44.3541Z"
            fill="black"
          />
          <path
            fill-rule="evenodd"
            clip-rule="evenodd"
            d="M72.1802 33H56.5V31H72.1802C73.1336 31 73.9544 31.6729 74.1414 32.6078L76.9806 46.8039L75.0194 47.1961L72.1802 33Z"
            fill="black"
          />
          <path d="M77 67C77 71.9706 72.9706 76 68 76C63.0294 76 59 71.9706 59 67C59 62.0294 63.0294 58 68 58C72.9706 58 77 62.0294 77 67Z" fill="white" />
          <path
            fill-rule="evenodd"
            clip-rule="evenodd"
            d="M68 74C71.866 74 75 70.866 75 67C75 63.134 71.866 60 68 60C64.134 60 61 63.134 61 67C61 70.866 64.134 74 68 74ZM68 76C72.9706 76 77 71.9706 77 67C77 62.0294 72.9706 58 68 58C63.0294 58 59 62.0294 59 67C59 71.9706 63.0294 76 68 76Z"
            fill="black"
          />
          <path d="M72 67C72 69.2091 70.2091 71 68 71C65.7909 71 64 69.2091 64 67C64 64.7909 65.7909 63 68 63C70.2091 63 72 64.7909 72 67Z" fill="white" />
          <path
            fill-rule="evenodd"
            clip-rule="evenodd"
            d="M68 69C69.1046 69 70 68.1046 70 67C70 65.8954 69.1046 65 68 65C66.8954 65 66 65.8954 66 67C66 68.1046 66.8954 69 68 69ZM68 71C70.2091 71 72 69.2091 72 67C72 64.7909 70.2091 63 68 63C65.7909 63 64 64.7909 64 67C64 69.2091 65.7909 71 68 71Z"
            fill="black"
          />
          <path d="M2 35H55V54H2V35Z" fill="url(#paint0_linear)" />
          <path
            fill-rule="evenodd"
            clip-rule="evenodd"
            d="M6 22C6 21.4477 5.55228 21 5 21H1C0.447715 21 0 21.4477 0 22V68C0 68.5523 0.447715 69 0.999999 69H56C56.5523 69 57 68.5523 57 68V22C57 21.4477 56.5523 21 56 21H52C51.4477 21 51 21.4477 51 22C51 22.5523 51.4477 23 52 23H55V67H2V23H5C5.55228 23 6 22.5523 6 22Z"
            fill="black"
          />
          <path d="M27 67C27 71.9706 22.9706 76 18 76C13.0294 76 9 71.9706 9 67C9 62.0294 13.0294 58 18 58C22.9706 58 27 62.0294 27 67Z" fill="white" />
          <path
            fill-rule="evenodd"
            clip-rule="evenodd"
            d="M18 74C21.866 74 25 70.866 25 67C25 63.134 21.866 60 18 60C14.134 60 11 63.134 11 67C11 70.866 14.134 74 18 74ZM18 76C22.9706 76 27 71.9706 27 67C27 62.0294 22.9706 58 18 58C13.0294 58 9 62.0294 9 67C9 71.9706 13.0294 76 18 76Z"
            fill="black"
          />
          <path d="M22 67C22 69.2091 20.2091 71 18 71C15.7909 71 14 69.2091 14 67C14 64.7909 15.7909 63 18 63C20.2091 63 22 64.7909 22 67Z" fill="white" />
          <path
            fill-rule="evenodd"
            clip-rule="evenodd"
            d="M18 69C19.1046 69 20 68.1046 20 67C20 65.8954 19.1046 65 18 65C16.8954 65 16 65.8954 16 67C16 68.1046 16.8954 69 18 69ZM18 71C20.2091 71 22 69.2091 22 67C22 64.7909 20.2091 63 18 63C15.7909 63 14 64.7909 14 67C14 69.2091 15.7909 71 18 71Z"
            fill="black"
          />
        </g>

        <defs>
          <linearGradient
            id="paint0_linear"
            x1="28.5"
            y1="35"
            x2="28.5"
            y2="54"
            gradientUnits="userSpaceOnUse"
          >
            <stop stop-color="#FE9620" />
            <stop offset="1" stop-color="#E94B30" />
          </linearGradient>
        </defs>
      </svg>

      <h1 class="mt-6 text-xl font-semibold text-base-master">
        Procure AI
      </h1>
      <p class="mt-1.5 text-sm text-base-500">
        Готовим загрузку прайс-листов…
      </p>

      <!-- Тонкий прогресс -->
      <div class="mt-5 w-40">
        <B24Progress
          :model-value="null"
          animation="carousel"
          color="air-primary"
          size="xs"
        />
      </div>
    </div>
  </div>
</template>

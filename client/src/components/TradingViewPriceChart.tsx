/**
 * TradingView 價格圖表組件
 * 使用 Lightweight Charts 顯示兩個交易所的實時價格與價差
 * 分為兩個獨立圖表：上方顯示價格走勢，下方顯示價差率
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createChart, LineData, Time } from 'lightweight-charts';
import { Card, Button, Space, Spin } from 'antd'; // 引入 Spin 組件
import { DoubleRightOutlined } from '@ant-design/icons';
import { getApiBaseUrl } from '../utils/env';
import { formatUnixTime, formatUnixTimeFull, formatPriceFixedWidth } from '../utils/formatters';
import { sendWebSocketMessage } from '../services/websocket';

interface TradingViewPriceChartProps {
  leg1Exchange: string;
  leg1Symbol: string;
  leg1Type?: 'spot' | 'linear';
  leg1Side?: 'buy' | 'sell';
  leg2Exchange: string;
  leg2Symbol: string;
  leg2Type?: 'spot' | 'linear';
  leg2Side?: 'buy' | 'sell';
  height?: number;
}

const TradingViewPriceChart: React.FC<TradingViewPriceChartProps> = ({
  leg1Exchange,
  leg1Symbol,
  leg1Type = 'spot',
  leg1Side = 'buy',
  leg2Exchange,
  leg2Symbol,
  leg2Type = 'linear',
  leg2Side = 'sell',
  height = 450,
}) => {
  // 上方圖表容器（價格）
  const priceChartContainerRef = useRef<HTMLDivElement>(null);
  const priceChartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const leg1SeriesRef = useRef<any>(null);
  const leg2SeriesRef = useRef<any>(null);

  // 下方圖表容器（價差率）
  const spreadChartContainerRef = useRef<HTMLDivElement>(null);
  const spreadChartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const spreadSeriesRef = useRef<any>(null);

  /** 避免 setCrosshairPosition 觸發對圖 subscribeCrosshairMove 造成互相同步迴圈 */
  const crosshairSyncingRef = useRef(false);
  const timeScaleSyncingRef = useRef(false);

  const [timeframe, setTimeframe] = useState<string>('1m');
  // 新增：Loading 狀態
  const [isLoading, setIsLoading] = useState(false);
  const [isRealtimeConnecting, setIsRealtimeConnecting] = useState(false);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);

  // 時間周期選項
  const timeframeOptions = [
    { label: '1S', value: '1s' },
    { label: '1m', value: '1m' },
    { label: '5m', value: '5m' },
    { label: '15m', value: '15m' },
    { label: '30m', value: '30m' },
    { label: '1H', value: '1h' },
    { label: '4H', value: '4h' },
    { label: '1D', value: '1d' },
  ];

  // 數據存儲
  const leg1DataRef = useRef<LineData[]>([]);
  const leg2DataRef = useRef<LineData[]>([]);
  const spreadDataRef = useRef<LineData[]>([]);

  // 精度存儲（根據交易所回傳的數據動態計算）
  const leg1PrecisionRef = useRef<number>(6);
  const leg2PrecisionRef = useRef<number>(6);

  // 追蹤已載入的數據量和最舊的時間戳
  const loadedCountRef = useRef<number>(0);
  const oldestTimestampRef = useRef<number | null>(null);
  const loadingMoreRef = useRef<boolean>(false);
  const requestIdRef = useRef<number>(0);
  const chartContextKeyRef = useRef<string>('');
  const timeframeRef = useRef<string>(timeframe);
  const loadMoreHistoricalDataRef = useRef<((targetCount: number) => Promise<void>) | null>(null);
  const realtimeConnectingTimerRef = useRef<number | null>(null);
  const latestChartTickerRef = useRef<{
    leg1?: { price: number; timestamp: number };
    leg2?: { price: number; timestamp: number };
  }>({});

  // 右側刻度寬度常數
  const RIGHT_SCALE_WIDTH = 76;
  const syncedRightScaleWidthRef = useRef(RIGHT_SCALE_WIDTH);

  const buildChartContextKey = useCallback(() => {
    return [
      leg1Exchange.toLowerCase(),
      leg1Symbol.toUpperCase(),
      leg1Type,
      leg2Exchange.toLowerCase(),
      leg2Symbol.toUpperCase(),
      leg2Type,
      timeframe,
    ].join('__');
  }, [leg1Exchange, leg1Symbol, leg1Type, leg2Exchange, leg2Symbol, leg2Type, timeframe]);

  useEffect(() => {
    timeframeRef.current = timeframe;
    chartContextKeyRef.current = buildChartContextKey();
  }, [timeframe, buildChartContextKey]);

  // 計算圖表高度（上方70%價格，下方30%價差）
  const priceChartHeight = Math.floor(height * 0.7);
  const spreadChartHeight = height - priceChartHeight - 8; // 8px 間距

  const calculateSpreadRatio = useCallback(
    (price1: number, price2: number): { ratio: number; percent: number } => {
      if (price1 <= 0 || price2 <= 0) {
        return { ratio: 100, percent: 0 };
      }
      let ratio = 100;
      if (leg1Side === 'sell' && leg2Side === 'buy') {
        ratio = (price1 / price2) * 100;
      } else if (leg1Side === 'buy' && leg2Side === 'sell') {
        ratio = (price2 / price1) * 100;
      }
      const percent = ratio - 100;
      return { ratio, percent };
    },
    [leg1Side, leg2Side],
  );

  /**
   * 從價格數據中計算精度
   * 根據價格值的大小和最小變化量來推斷交易所的實際精度
   */
  const calculatePrecision = useCallback((prices: number[]): number => {
    if (!prices || prices.length === 0) return 6; // 默認精度

    const validPrices = prices.filter(p => typeof p === 'number' && !isNaN(p) && p > 0);
    if (validPrices.length === 0) return 6;

    // 分析價格的最小變化量來推斷精度
    let minDiff = Infinity;
    const sortedPrices = [...validPrices].sort((a, b) => a - b);
    for (let i = 1; i < sortedPrices.length; i++) {
      const diff = sortedPrices[i] - sortedPrices[i - 1];
      if (diff > 0 && diff < minDiff) {
        minDiff = diff;
      }
    }

    // 計算平均價格，用於輔助判斷
    const avgPrice = validPrices.reduce((sum, p) => sum + p, 0) / validPrices.length;
    
    let precision = 6; // 默認精度

    // 如果檢測到最小變化量，根據變化量推斷精度
    if (minDiff < Infinity && minDiff > 0) {
      // 將最小變化量轉換為字符串來分析精度
      // 使用較高的精度來格式化，確保能捕獲所有小數位
      const diffStr = minDiff.toFixed(10);
      
      if (diffStr.includes('.')) {
        const decimalPart = diffStr.split('.')[1];
        // 找到第一個非零數字後的有效位數
        let firstNonZero = -1;
        for (let i = 0; i < decimalPart.length; i++) {
          if (decimalPart[i] !== '0') {
            firstNonZero = i;
            break;
          }
        }
        if (firstNonZero >= 0) {
          // 第一個非零數字的位置 + 後續有效位數（通常交易所會保留2-3位有效位）
          precision = Math.min(firstNonZero + 3, 8);
        }
      }
    }

    // 根據平均價格調整精度（輔助判斷）
    // 小價格通常需要更高精度
    if (avgPrice < 0.001) {
      precision = Math.max(precision, 7);
    } else if (avgPrice < 0.01) {
      precision = Math.max(precision, 6);
    } else if (avgPrice < 0.1) {
      precision = Math.max(precision, 5);
    } else if (avgPrice < 1) {
      precision = Math.max(precision, 4);
    } else if (avgPrice < 10) {
      precision = Math.max(precision, 3);
    } else if (avgPrice < 100) {
      precision = Math.max(precision, 2);
    } else if (avgPrice < 1000) {
      precision = Math.max(precision, 1);
    }
    
    // 限制精度範圍在 0-8 之間
    return Math.min(Math.max(precision, 0), 8);
  }, []);

  // 緩存時間格式化函數，避免時區改變時重新創建圖表
  // 這些函數會在時區改變時自動使用新的時區，但不會觸發圖表重新初始化
  const timeFormatter = useCallback((time: Time) => {
    return formatUnixTimeFull(Number(time));
  }, []);

  const tickMarkFormatter = useCallback((time: Time) => {
    return formatUnixTime(Number(time), timeframeRef.current === '1s' ? 'HH:mm:ss' : 'HH:mm');
  }, []);

  // 使用固定寬度格式化器，確保價格標籤對齊（9個字符，包括數字和小數點）
  const priceFormatter = useCallback((price: number) => {
    return formatPriceFixedWidth(price);
  }, []);

  const spreadPriceFormatter = useCallback((price: number) => {
    return `${formatPriceFixedWidth(price)}%`;
  }, []);

  const syncRightPriceScaleWidth = useCallback(() => {
    const priceChart = priceChartRef.current;
    const spreadChart = spreadChartRef.current;
    if (!priceChart || !spreadChart) return;
    try {
      const priceScaleWidth = priceChart.priceScale('right').width();
      const spreadScaleWidth = spreadChart.priceScale('right').width();
      const syncedWidth = Math.max(RIGHT_SCALE_WIDTH, priceScaleWidth, spreadScaleWidth);
      if (Math.abs(syncedWidth - syncedRightScaleWidthRef.current) < 1) {
        return;
      }
      syncedRightScaleWidthRef.current = syncedWidth;
      priceChart.applyOptions({
        rightPriceScale: { minimumWidth: syncedWidth } as any,
      });
      spreadChart.applyOptions({
        rightPriceScale: { minimumWidth: syncedWidth } as any,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('disposed')) {
        return;
      }
      console.debug('同步右側刻度寬度時發生錯誤（可忽略）:', error);
    }
  }, []);

  const updateScrollToLatestButton = useCallback(() => {
    const shouldShow = [priceChartRef.current, spreadChartRef.current].some((chart) => {
      if (!chart?.timeScale) return false;
      try {
        return Math.abs(chart.timeScale().scrollPosition()) > 0.5;
      } catch (error) {
        return false;
      }
    });

    setShowScrollToLatest(shouldShow);
  }, []);

  const scrollToLatest = useCallback(() => {
    [priceChartRef.current, spreadChartRef.current].forEach((chart) => {
      if (!chart?.timeScale) return;
      try {
        chart.timeScale().scrollToRealTime();
      } catch (error) {
        // chart disposed
      }
    });
    setShowScrollToLatest(false);
  }, []);

  // 同步時間軸的函數
  const stopRealtimeConnecting = useCallback(() => {
    if (realtimeConnectingTimerRef.current) {
      window.clearTimeout(realtimeConnectingTimerRef.current);
      realtimeConnectingTimerRef.current = null;
    }
    setIsRealtimeConnecting(false);
  }, []);

  const startRealtimeConnecting = useCallback(() => {
    stopRealtimeConnecting();
    setIsRealtimeConnecting(true);
    realtimeConnectingTimerRef.current = window.setTimeout(() => {
      realtimeConnectingTimerRef.current = null;
      setIsRealtimeConnecting(false);
    }, 5000);
  }, [stopRealtimeConnecting]);

  useEffect(() => {
    if (timeframe !== '1s') {
      stopRealtimeConnecting();
    }
    return () => {
      if (realtimeConnectingTimerRef.current) {
        window.clearTimeout(realtimeConnectingTimerRef.current);
        realtimeConnectingTimerRef.current = null;
      }
    };
  }, [timeframe, stopRealtimeConnecting]);

  const syncTimeScales = useCallback((sourceChart: any, targetChart: any) => {
    if (!sourceChart || !targetChart) return;
    if (timeScaleSyncingRef.current) return;
    try {
      // 檢查圖表是否已銷毀
      if (!sourceChart.timeScale || !targetChart.timeScale) return;

      const sourceTimeScale = sourceChart.timeScale();
      const targetTimeScale = targetChart.timeScale();

      if (!sourceTimeScale || !targetTimeScale) return;

      const visibleRange = sourceTimeScale.getVisibleRange();
      if (visibleRange && visibleRange.from !== null && visibleRange.to !== null) {
        const targetRange = targetTimeScale.getVisibleRange();
        if (targetRange) {
          const sameRange =
            Math.abs(Number(targetRange.from) - Number(visibleRange.from)) < 0.001 &&
            Math.abs(Number(targetRange.to) - Number(visibleRange.to)) < 0.001;
          if (!sameRange) {
            timeScaleSyncingRef.current = true;
            targetTimeScale.setVisibleRange(visibleRange);
            window.setTimeout(() => {
              timeScaleSyncingRef.current = false;
            }, 0);
          }
        }
      }
    } catch (error) {
      timeScaleSyncingRef.current = false;
      if (error instanceof Error && error.message.includes('disposed')) {
        return;
      }
      console.debug('時間軸同步錯誤（可忽略）:', error);
    }
  }, []);

  // 初始化價格圖表（上方）- 只在組件掛載時初始化一次
  useEffect(() => {
    if (!priceChartContainerRef.current) return;

    const chart = createChart(priceChartContainerRef.current, {
      width: priceChartContainerRef.current.clientWidth,
      height: priceChartHeight,
      layout: {
        background: { color: '#0b0e11' },
        textColor: '#848e9c',
      },
      grid: {
        vertLines: { color: '#1e2329', visible: false },
        horzLines: {
          color: '#2b3139',
          visible: true,
          style: 0,
        },
      },
      localization: {
        timeFormatter: timeFormatter,
        priceFormatter: priceFormatter,
      },
      crosshair: {
        mode: 1,
        vertLine: {
          width: 1,
          color: '#758696',
          style: 3,
          labelBackgroundColor: '#f0b90b',
        },
        horzLine: {
          width: 1,
          color: '#758696',
          style: 3,
          labelBackgroundColor: '#f0b90b',
        },
      } as any,
      rightPriceScale: {
        visible: true,
        borderColor: '#2b3139',
        scaleMargins: {
          top: 0.05,
          bottom: 0.1,
        },
        minimumWidth: RIGHT_SCALE_WIDTH,
      },
      leftPriceScale: {
        visible: false,
      },
      // 隱藏時間軸刻度區；游標時間改由下方圖（可見時間軸）透過十字線同步顯示
      timeScale: {
        borderColor: '#2b3139',
        timeVisible: false,
        secondsVisible: false,
        visible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
        tickMarkFormatter: tickMarkFormatter,
        minBarSpacing: 0.5,
        rightOffset: 5,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
    } as any);

    priceChartRef.current = chart;

    chart.applyOptions({
      rightPriceScale: {
        minimumWidth: RIGHT_SCALE_WIDTH,
      } as any,
    });

    const leg1Series = chart.addLineSeries({
      color: '#f59e42',
      lineWidth: 2,
      priceScaleId: 'right',
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      lastValueVisible: true,
      priceLineVisible: true,
      title: `${leg1Exchange.toUpperCase()} ${leg1Symbol}`,
      priceFormat: {
        type: 'price',
        precision: leg1PrecisionRef.current,
        minMove: Math.pow(10, -leg1PrecisionRef.current),
      },
    });
    leg1SeriesRef.current = leg1Series;

    const leg2Series = chart.addLineSeries({
      color: '#4a9eff',
      lineWidth: 2,
      priceScaleId: 'right',
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      lastValueVisible: true,
      priceLineVisible: true,
      title: `${leg2Exchange.toUpperCase()} ${leg2Symbol}`,
      priceFormat: {
        type: 'price',
        precision: leg2PrecisionRef.current,
        minMove: Math.pow(10, -leg2PrecisionRef.current),
      },
    });
    leg2SeriesRef.current = leg2Series;
    syncRightPriceScaleWidth();

    let syncTimer: NodeJS.Timeout | null = null;
    let scrollLoadTimer: NodeJS.Timeout | null = null;
    try {
      chart.timeScale().subscribeVisibleTimeRangeChange(() => {
        updateScrollToLatestButton();
        if (priceChartRef.current && spreadChartRef.current) {
          if (syncTimer) {
            clearTimeout(syncTimer);
          }
          syncTimer = setTimeout(() => {
            try {
              syncTimeScales(priceChartRef.current, spreadChartRef.current);
            } catch (error) {
              if (error instanceof Error && error.message.includes('disposed')) {
                return;
              }
            }
          }, 50);

          // 檢查是否需要加載更多歷史數據（滾動到左邊緣時）
          if (scrollLoadTimer) {
            clearTimeout(scrollLoadTimer);
          }
          scrollLoadTimer = setTimeout(() => {
            try {
              const visibleRange = chart.timeScale().getVisibleRange();
              if (visibleRange && visibleRange.from !== null && oldestTimestampRef.current !== null) {
                const visibleStart = Number(visibleRange.from);
                const oldestTime = oldestTimestampRef.current;
                const intervalSeconds = getIntervalSeconds(timeframeRef.current);
                // 當可視範圍接近最舊數據時（距離 10% 範圍內），觸發加載
                const threshold = intervalSeconds * 100; // 約 100 根 K 線的範圍
                
                if (visibleStart <= oldestTime + threshold && !loadingMoreRef.current) {
                  // 計算目標數量：當前數量 + 1000
                  const nextTarget = loadedCountRef.current + 1000;
                  const MAX_DATA_POINTS = 1440 * 30;
                  
                  if (nextTarget <= MAX_DATA_POINTS && loadMoreHistoricalDataRef.current) {
                    loadMoreHistoricalDataRef.current(nextTarget);
                  }
                }
              }
            } catch (error) {
              // 忽略錯誤
            }
          }, 200);
        }
      });
    } catch (error) {
      console.debug('訂閱時間軸變化時發生錯誤（可忽略）:', error);
    }

    return () => {
      if (syncTimer) {
        clearTimeout(syncTimer);
      }
      if (scrollLoadTimer) {
        clearTimeout(scrollLoadTimer);
      }
      try {
        if (chart) {
          chart.remove();
        }
      } catch (error) {
        console.debug('清理價格圖表時發生錯誤（可忽略）:', error);
      }
      priceChartRef.current = null;
      leg1SeriesRef.current = null;
      leg2SeriesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceChartHeight, syncTimeScales, syncRightPriceScaleWidth, updateScrollToLatestButton]); // eslint-disable-line react-hooks/exhaustive-deps

  // 初始化價差率圖表（下方）- 只在組件掛載時初始化一次
  useEffect(() => {
    if (!spreadChartContainerRef.current) return;

    const chart = createChart(spreadChartContainerRef.current, {
      width: spreadChartContainerRef.current.clientWidth,
      height: spreadChartHeight,
      layout: {
        background: { color: '#0b0e11' },
        textColor: '#848e9c',
      },
      grid: {
        vertLines: { color: '#1e2329', visible: false },
        horzLines: {
          color: '#2b3139',
          visible: true,
          style: 0,
        },
      },
      localization: {
        timeFormatter: timeFormatter,
        priceFormatter: spreadPriceFormatter,
      },
      crosshair: {
        mode: 1,
        vertLine: {
          width: 1,
          color: '#758696',
          style: 3,
          labelBackgroundColor: '#f0b90b',
        },
        horzLine: {
          width: 1,
          color: '#758696',
          style: 3,
          labelBackgroundColor: '#f0b90b',
        },
      } as any,
      rightPriceScale: {
        visible: true,
        borderColor: '#2b3139',
        scaleMargins: {
          top: 0.05,
          bottom: 0.1,
        },
        minimumWidth: RIGHT_SCALE_WIDTH,
      },
      leftPriceScale: {
        visible: false,
      },
      timeScale: {
        borderColor: '#2b3139',
        timeVisible: true,
        secondsVisible: true,
        fixLeftEdge: true,
        fixRightEdge: true,
        tickMarkFormatter: tickMarkFormatter,
        minBarSpacing: 0.5,
        rightOffset: 5,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
    } as any);

    spreadChartRef.current = chart;

    chart.applyOptions({
      rightPriceScale: {
        minimumWidth: RIGHT_SCALE_WIDTH,
      } as any,
    });

    // @ts-ignore
    const spreadSeries = chart.addBaselineSeries({
      priceScaleId: 'right',
      baseValue: { type: 'price', price: 0 },
      topLineColor: '#0ecb81',
      bottomLineColor: '#f6465d',
      topFillColor1: 'rgba(14, 203, 129, 0.45)',
      topFillColor2: 'rgba(14, 203, 129, 0.15)',
      bottomFillColor1: 'rgba(246, 70, 93, 0.45)',
      bottomFillColor2: 'rgba(246, 70, 93, 0.15)',
      lineWidth: 2,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      lastValueVisible: true,
      priceLineVisible: false,
      title: '價差 (%)',
      priceFormat: {
        type: 'price',
        precision: 6,  // 價差百分比使用 6 位小數
        minMove: 0.0001,  // 最小變動單位
      },
    });
    spreadSeriesRef.current = spreadSeries;
    syncRightPriceScaleWidth();

    spreadSeries.createPriceLine({
      price: 0,
      color: '#848e9c',
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: false,
      title: '',
    });

    let syncTimer2: NodeJS.Timeout | null = null;
    try {
      chart.timeScale().subscribeVisibleTimeRangeChange(() => {
        updateScrollToLatestButton();
        if (spreadChartRef.current && priceChartRef.current) {
          if (syncTimer2) {
            clearTimeout(syncTimer2);
          }
          syncTimer2 = setTimeout(() => {
            try {
              syncTimeScales(spreadChartRef.current, priceChartRef.current);
            } catch (error) {
              if (error instanceof Error && error.message.includes('disposed')) {
                return;
              }
            }
          }, 50);
        }
      });
    } catch (error) {
      console.debug('訂閱時間軸變化時發生錯誤（可忽略）:', error);
    }

    return () => {
      if (syncTimer2) {
        clearTimeout(syncTimer2);
      }
      try {
        if (chart) {
          chart.remove();
        }
      } catch (error) {
        console.debug('清理價差圖表時發生錯誤（可忽略）:', error);
      }
      spreadChartRef.current = null;
      spreadSeriesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spreadChartHeight, syncTimeScales, syncRightPriceScaleWidth, updateScrollToLatestButton]); // eslint-disable-line react-hooks/exhaustive-deps

  // 上下圖十字線雙向同步（須在兩張圖都建立後訂閱）
  useEffect(() => {
    const priceChart = priceChartRef.current;
    const spreadChart = spreadChartRef.current;
    const leg1Series = leg1SeriesRef.current;
    const spreadSeries = spreadSeriesRef.current;

    if (!priceChart || !spreadChart || !leg1Series || !spreadSeries) {
      return;
    }

    const findValueByTime = (series: { data: () => readonly { time?: Time; value?: number }[] }, t: Time | undefined) => {
      if (t === undefined) return undefined;
      const tn = Number(t);
      for (const row of series.data()) {
        if (Number(row.time) === tn && typeof row.value === 'number') {
          return row.value;
        }
      }
      return undefined;
    };

    const isOutsidePane = (point: { x: number; y: number } | undefined, chart: NonNullable<typeof priceChart>) => {
      if (!point) return true;
      const { width, height } = chart.paneSize();
      return point.x < 0 || point.y < 0 || point.x > width || point.y > height;
    };

    const onPriceCrosshairMove = (param: { point?: { x: number; y: number }; time?: Time }) => {
      if (crosshairSyncingRef.current) return;

      if (isOutsidePane(param.point, priceChart) || param.time === undefined) {
        crosshairSyncingRef.current = true;
        try {
          spreadChart.clearCrosshairPosition();
        } catch {
          /* chart disposed */
        } finally {
          crosshairSyncingRef.current = false;
        }
        return;
      }

      const spreadValue = findValueByTime(spreadSeries, param.time);
      if (spreadValue === undefined) return;

      crosshairSyncingRef.current = true;
      try {
        spreadChart.setCrosshairPosition(spreadValue, param.time, spreadSeries);
      } catch {
        /* chart disposed */
      } finally {
        crosshairSyncingRef.current = false;
      }
    };

    const onSpreadCrosshairMove = (param: { point?: { x: number; y: number }; time?: Time }) => {
      if (crosshairSyncingRef.current) return;

      if (isOutsidePane(param.point, spreadChart) || param.time === undefined) {
        crosshairSyncingRef.current = true;
        try {
          priceChart.clearCrosshairPosition();
        } catch {
          /* chart disposed */
        } finally {
          crosshairSyncingRef.current = false;
        }
        return;
      }

      const leg1Value = findValueByTime(leg1Series, param.time);
      if (leg1Value === undefined) return;

      crosshairSyncingRef.current = true;
      try {
        priceChart.setCrosshairPosition(leg1Value, param.time, leg1Series);
      } catch {
        /* chart disposed */
      } finally {
        crosshairSyncingRef.current = false;
      }
    };

    priceChart.subscribeCrosshairMove(onPriceCrosshairMove);
    spreadChart.subscribeCrosshairMove(onSpreadCrosshairMove);

    return () => {
      try {
        priceChart.unsubscribeCrosshairMove(onPriceCrosshairMove);
      } catch {
        /* disposed */
      }
      try {
        spreadChart.unsubscribeCrosshairMove(onSpreadCrosshairMove);
      } catch {
        /* disposed */
      }
    };
  }, [priceChartHeight, spreadChartHeight]);

  // 使用 ResizeObserver 監聽價格圖表容器大小變化
  useEffect(() => {
    if (!priceChartContainerRef.current || !priceChartRef.current) return;

    const resizeObserver = new ResizeObserver((entries) => {
      // 當容器大小改變時，自動調整圖表
      for (const entry of entries) {
        const { width } = entry.contentRect;
        // 這裡的高度維持 priceChartHeight 計算邏輯，因為高度是由 JS 控制的
        try {
          priceChartRef.current?.applyOptions({
            width: width,
            rightPriceScale: { minimumWidth: RIGHT_SCALE_WIDTH } as any,
          });
          syncRightPriceScaleWidth();
        } catch (error) {
          if (error instanceof Error && error.message.includes('disposed')) {
            return;
          }
          console.debug('調整價格圖表大小時發生錯誤（可忽略）:', error);
        }
      }
    });

    resizeObserver.observe(priceChartContainerRef.current);

    return () => resizeObserver.disconnect();
  }, [priceChartHeight, syncRightPriceScaleWidth]);

  // 使用 ResizeObserver 監聽價差圖表容器大小變化
  useEffect(() => {
    if (!spreadChartContainerRef.current || !spreadChartRef.current) return;

    const resizeObserver = new ResizeObserver((entries) => {
      // 當容器大小改變時，自動調整圖表
      for (const entry of entries) {
        const { width } = entry.contentRect;
        // 這裡的高度維持 spreadChartHeight 計算邏輯，因為高度是由 JS 控制的
        try {
          spreadChartRef.current?.applyOptions({
            width: width,
            rightPriceScale: { minimumWidth: RIGHT_SCALE_WIDTH } as any,
          });
          syncRightPriceScaleWidth();
        } catch (error) {
          if (error instanceof Error && error.message.includes('disposed')) {
            return;
          }
          console.debug('調整價差圖表大小時發生錯誤（可忽略）:', error);
        }
      }
    });

    resizeObserver.observe(spreadChartContainerRef.current);

    return () => resizeObserver.disconnect();
  }, [spreadChartHeight, syncRightPriceScaleWidth]);

  // 更新圖表標題（當幣種或交易所改變時）
  useEffect(() => {
    try {
      if (leg1SeriesRef.current) {
        leg1SeriesRef.current.applyOptions({
          title: `${leg1Exchange.toUpperCase()} ${leg1Symbol}`,
        });
      }
      if (leg2SeriesRef.current) {
        leg2SeriesRef.current.applyOptions({
          title: `${leg2Exchange.toUpperCase()} ${leg2Symbol}`,
        });
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('disposed')) {
        return;
      }
      console.debug('更新圖表標題時發生錯誤（可忽略）:', error);
    }
  }, [leg1Exchange, leg1Symbol, leg2Exchange, leg2Symbol]);

  // 根據 interval 計算單根 K 線的時間間隔（秒）
  const getIntervalSeconds = useCallback((interval: string): number => {
    const intervalMap: { [key: string]: number } = {
      '1s': 1,
      '1m': 60,
      '3m': 180,
      '5m': 300,
      '15m': 900,
      '30m': 1800,
      '1h': 3600,
      '2h': 7200,
      '4h': 14400,
      '6h': 21600,
      '12h': 43200,
      '1d': 86400,
      '1w': 604800,
      '1M': 2592000,
    };
    return intervalMap[interval] || 60;
  }, []);

  const getBucketStartTime = useCallback((timestampMs: number, interval: string): Time => {
    const timestampSeconds = Math.floor(timestampMs / 1000);
    const intervalSeconds = getIntervalSeconds(interval);
    return (Math.floor(timestampSeconds / intervalSeconds) * intervalSeconds) as Time;
  }, [getIntervalSeconds]);

  const upsertLinePoint = useCallback((data: LineData[], point: LineData): LineData[] => {
    const pointTime = Number(point.time);
    const last = data[data.length - 1];

    if (!last || Number(last.time) < pointTime) {
      return [...data, point];
    }

    if (Number(last.time) === pointTime) {
      return [...data.slice(0, -1), point];
    }

    const index = data.findIndex(item => Number(item.time) === pointTime);
    if (index >= 0) {
      const next = [...data];
      next[index] = point;
      return next;
    }

    return [...data, point].sort((a, b) => Number(a.time) - Number(b.time));
  }, []);

  // 載入歷史 K 線數據（支持時間範圍）
  const getMaxDataPoints = useCallback(() => {
    return timeframeRef.current === '1s' ? 3600 : 1440 * 30;
  }, []);

  const applyLivePricePoint = useCallback((price1: number, price2: number, timestampMs: number) => {
    if (!leg1SeriesRef.current || !leg2SeriesRef.current || !spreadSeriesRef.current) return;
    if (price1 <= 0 || price2 <= 0) return;

    const time = getBucketStartTime(timestampMs, timeframeRef.current);
    const { percent } = calculateSpreadRatio(price1, price2);

    const leg1Point: LineData = { time, value: price1 };
    const leg2Point: LineData = { time, value: price2 };
    const spreadPoint: LineData = { time, value: percent };

    leg1DataRef.current = upsertLinePoint(leg1DataRef.current, leg1Point);
    leg2DataRef.current = upsertLinePoint(leg2DataRef.current, leg2Point);
    spreadDataRef.current = upsertLinePoint(spreadDataRef.current, spreadPoint);

    const maxDataPoints = getMaxDataPoints();
    if (leg1DataRef.current.length > maxDataPoints) leg1DataRef.current = leg1DataRef.current.slice(-maxDataPoints);
    if (leg2DataRef.current.length > maxDataPoints) leg2DataRef.current = leg2DataRef.current.slice(-maxDataPoints);
    if (spreadDataRef.current.length > maxDataPoints) spreadDataRef.current = spreadDataRef.current.slice(-maxDataPoints);

    loadedCountRef.current = Math.min(leg1DataRef.current.length, leg2DataRef.current.length);
    if (leg1DataRef.current.length > 0 && leg2DataRef.current.length > 0) {
      oldestTimestampRef.current = Math.max(
        Number(leg1DataRef.current[0].time),
        Number(leg2DataRef.current[0].time)
      );
    }

    try {
      if (leg1SeriesRef.current) leg1SeriesRef.current.update(leg1Point);
      if (leg2SeriesRef.current) leg2SeriesRef.current.update(leg2Point);
      if (spreadSeriesRef.current) spreadSeriesRef.current.update(spreadPoint);
    } catch (error) {
      if (error instanceof Error && error.message.includes('disposed')) {
        return;
      }
      console.debug('?湔?”?豢???隤歹??臬蕭?伐?:', error);
    }
  }, [calculateSpreadRatio, getBucketStartTime, getMaxDataPoints, upsertLinePoint]);

  const loadKlinesWithTimeRange = useCallback(async (
    exchange: string,
    symbol: string,
    category: string,
    interval: string,
    limit: number,
    endTime?: number
  ): Promise<any[]> => {
    const apiBase = getApiBaseUrl();
    let url = `${apiBase}/api/klines/${exchange}/${symbol}?category=${category}&interval=${interval}&limit=${limit}`;
    
    if (endTime !== undefined) {
      // 僅傳 endTime，讓後端自行處理時間窗口，避免 OKX before/after 拼接錯亂
      url += `&endTime=${endTime}`;
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`API error (${response.status})`);
    }
    const result = await response.json();
    return result.success ? result.data : [];
  }, []);

  // 合併新數據到現有數據（按時間排序，去重）
  const mergeKlineData = useCallback((existing: LineData[], newData: any[]): LineData[] => {
    const newLineData: LineData[] = newData.map((k: any) => ({
      time: k.time as Time,
      value: k.close,
    }));

    // 合併並去重
    const combined = [...existing, ...newLineData];
    const uniqueMap = new Map<number, LineData>();
    combined.forEach(item => {
      const time = Number(item.time);
      if (!uniqueMap.has(time) || uniqueMap.get(time)!.value !== item.value) {
        uniqueMap.set(time, item);
      }
    });

    // 按時間排序
    return Array.from(uniqueMap.values()).sort((a, b) => Number(a.time) - Number(b.time));
  }, []);

  // 更新價差數據的輔助函數
  const updateSpreadData = useCallback(() => {
    if (leg1DataRef.current.length > 0 && leg2DataRef.current.length > 0) {
      const spreadLineData: LineData[] = [];
      // 重要：按時間戳對齊兩腿 K 線，避免用索引對齊造成跨時間錯配（特別是日線）
      const leg2Map = new Map<number, number>();
      leg2DataRef.current.forEach((item) => {
        leg2Map.set(Number(item.time), item.value);
      });

      leg1DataRef.current.forEach((item) => {
        const ts = Number(item.time);
        const price2 = leg2Map.get(ts);
        if (price2 === undefined) return;
        const { percent } = calculateSpreadRatio(item.value, price2);
        spreadLineData.push({
          time: item.time,
          value: percent,
        });
      });

      spreadLineData.sort((a, b) => Number(a.time) - Number(b.time));

      if (spreadSeriesRef.current) {
        spreadSeriesRef.current.setData(spreadLineData);
        spreadDataRef.current = spreadLineData;
      }
    } else {
      if (spreadSeriesRef.current) spreadSeriesRef.current.setData([]);
    }
    syncRightPriceScaleWidth();
  }, [calculateSpreadRatio, syncRightPriceScaleWidth]);

  // 加載更多歷史數據（自動加載和滾動觸發）
  const loadMoreHistoricalData = useCallback(async (targetCount: number) => {
    if (timeframeRef.current === '1s') return;
    if (loadingMoreRef.current || !oldestTimestampRef.current) return;
    const MAX_DATA_POINTS = 1440 * 30;
    if (loadedCountRef.current >= MAX_DATA_POINTS) return;
    const currentRequestId = requestIdRef.current;
    const currentContextKey = buildChartContextKey();
    if (loadedCountRef.current >= targetCount && targetCount < 3000) {
      // 如果已經達到目標數量且目標小於 3000，嘗試加載下一批次
      if (targetCount === 2000) {
        // 第二次完成後，加載第三次（3000~2001）
        setTimeout(() => {
          loadMoreHistoricalData(3000);
        }, 500);
      }
      return;
    }

    loadingMoreRef.current = true;

    try {
      const intervalSeconds = getIntervalSeconds(timeframe);
      // 計算需要載入的數量（每次加載 1000 條）
      const needLoad = Math.min(1000, Math.min(MAX_DATA_POINTS - loadedCountRef.current, targetCount - loadedCountRef.current));
      if (needLoad <= 0) {
        loadingMoreRef.current = false;
        return;
      }
      
      // 計算結束時間：從最舊的時間戳往前推一個間隔
      const endTime = oldestTimestampRef.current - intervalSeconds;
      
      const [leg1NewData, leg2NewData] = await Promise.all([
        loadKlinesWithTimeRange(leg1Exchange, leg1Symbol, leg1Type, timeframe, needLoad, endTime),
        loadKlinesWithTimeRange(leg2Exchange, leg2Symbol, leg2Type, timeframe, needLoad, endTime),
      ]);

      if (currentRequestId !== requestIdRef.current || currentContextKey !== chartContextKeyRef.current) {
        loadingMoreRef.current = false;
        return;
      }

      // 合併新數據到現有數據前面
      if (leg1NewData.length > 0) {
        leg1DataRef.current = mergeKlineData(leg1DataRef.current, leg1NewData);
        if (leg1SeriesRef.current) {
          leg1SeriesRef.current.setData(leg1DataRef.current);
        }
      }

      if (leg2NewData.length > 0) {
        leg2DataRef.current = mergeKlineData(leg2DataRef.current, leg2NewData);
        if (leg2SeriesRef.current) {
          leg2SeriesRef.current.setData(leg2DataRef.current);
        }
      }

      // 更新狀態
      loadedCountRef.current = Math.min(leg1DataRef.current.length, leg2DataRef.current.length);
      if (leg1DataRef.current.length > 0 && leg2DataRef.current.length > 0) {
        oldestTimestampRef.current = Math.max(
          Number(leg1DataRef.current[0].time),
          Number(leg2DataRef.current[0].time)
        );
      }

      // 更新價差
      updateSpreadData();
      syncRightPriceScaleWidth();

      // 如果達到目標，繼續加載下一批次
      if (loadedCountRef.current >= targetCount && targetCount < 3000) {
        if (targetCount === 2000) {
          // 第二次完成後，加載第三次（3000~2001）
          setTimeout(() => {
            loadMoreHistoricalData(3000);
          }, 500);
        }
      }

    } catch (error) {
      console.error('加載更多歷史數據失敗:', error);
    } finally {
      loadingMoreRef.current = false;
    }
  }, [leg1Exchange, leg1Symbol, leg1Type, leg2Exchange, leg2Symbol, leg2Type, timeframe, getIntervalSeconds, loadKlinesWithTimeRange, mergeKlineData, updateSpreadData, syncRightPriceScaleWidth]);

  useEffect(() => {
    loadMoreHistoricalDataRef.current = loadMoreHistoricalData;
  }, [loadMoreHistoricalData]);

  const buildTickerSubscriptions = useCallback(() => ([
    {
      exchange: leg1Exchange,
      symbol: String(leg1Symbol || '').toUpperCase(),
      category: leg1Type,
    },
    {
      exchange: leg2Exchange,
      symbol: String(leg2Symbol || '').toUpperCase(),
      category: leg2Type,
    },
  ]), [leg1Exchange, leg1Symbol, leg1Type, leg2Exchange, leg2Symbol, leg2Type]);

  // 載入歷史 K 線數據
  useEffect(() => {
    if (!leg1Exchange || !leg2Exchange || !leg1Symbol || !leg2Symbol) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    loadedCountRef.current = 0;
    oldestTimestampRef.current = null;
    loadingMoreRef.current = false;
    chartContextKeyRef.current = buildChartContextKey();
    const currentRequestId = ++requestIdRef.current;
    const currentContextKey = chartContextKeyRef.current;

    const loadHistoricalData = async () => {
      if (!priceChartRef.current || !spreadChartRef.current) return;
      if (!leg1SeriesRef.current || !leg2SeriesRef.current || !spreadSeriesRef.current) return;

      try {
        // 清空現有圖表數據，避免新幣種殘留
        leg1DataRef.current = [];
        leg2DataRef.current = [];
        spreadDataRef.current = [];
        leg1SeriesRef.current.setData([]);
        leg2SeriesRef.current.setData([]);
        spreadSeriesRef.current.setData([]);
        latestChartTickerRef.current = {};

        if (timeframe === '1s') {
          loadedCountRef.current = 0;
          oldestTimestampRef.current = null;
          startRealtimeConnecting();
          syncRightPriceScaleWidth();
          return;
        }

        // 第一次：請求最近 1000 條
        const [leg1Data, leg2Data] = await Promise.all([
          loadKlinesWithTimeRange(leg1Exchange, leg1Symbol, leg1Type, timeframe, 1000),
          loadKlinesWithTimeRange(leg2Exchange, leg2Symbol, leg2Type, timeframe, 1000),
        ]);

        // 若期間已切換幣種/時間框，則丟棄結果
        if (currentRequestId !== requestIdRef.current || currentContextKey !== chartContextKeyRef.current) return;

        leg1DataRef.current = [];
        leg2DataRef.current = [];

        // --- 處理 Leg 1 ---
        if (leg1Data.length > 0) {
          const leg1LineData: LineData[] = leg1Data.map((k: any) => ({
            time: k.time as Time,
            value: k.close,
          }));
          const leg1Precision = calculatePrecision(leg1LineData.map(d => d.value));
          leg1PrecisionRef.current = leg1Precision;
          if (leg1SeriesRef.current) {
            leg1SeriesRef.current.applyOptions({
              priceFormat: {
                type: 'price',
                precision: leg1Precision,
                minMove: Math.pow(10, -leg1Precision),
              },
            });
            leg1SeriesRef.current.setData(leg1LineData);
            leg1DataRef.current = leg1LineData;
          }
        }

        // --- 處理 Leg 2 ---
        if (leg2Data.length > 0) {
          const leg2LineData: LineData[] = leg2Data.map((k: any) => ({
            time: k.time as Time,
            value: k.close,
          }));
          const leg2Precision = calculatePrecision(leg2LineData.map(d => d.value));
          leg2PrecisionRef.current = leg2Precision;
          if (leg2SeriesRef.current) {
            leg2SeriesRef.current.applyOptions({
              priceFormat: {
                type: 'price',
                precision: leg2Precision,
                minMove: Math.pow(10, -leg2Precision),
              },
            });
            leg2SeriesRef.current.setData(leg2LineData);
            leg2DataRef.current = leg2LineData;
          }
        }

        // 更新載入狀態
        loadedCountRef.current = Math.min(leg1DataRef.current.length, leg2DataRef.current.length);
        if (leg1DataRef.current.length > 0 && leg2DataRef.current.length > 0) {
          oldestTimestampRef.current = Math.max(
            Number(leg1DataRef.current[0].time),
            Number(leg2DataRef.current[0].time)
          );
        }

        // --- 計算與處理價差 ---
        updateSpreadData();
        syncRightPriceScaleWidth();

        // 自動加載更多數據：第二次（2000~1001）
        // 延遲一點時間，確保首次載入完成後再開始
        setTimeout(() => {
          loadMoreHistoricalData(2000);
        }, 500);

      } catch (error) {
        console.error('歷史數據載入失敗:', error);
        try {
          if (leg1SeriesRef.current) leg1SeriesRef.current.setData([]);
          if (leg2SeriesRef.current) leg2SeriesRef.current.setData([]);
          if (spreadSeriesRef.current) spreadSeriesRef.current.setData([]);
        } catch (e) {
          // 忽略已銷毀對象的錯誤
        }
        leg1DataRef.current = [];
        leg2DataRef.current = [];
        spreadDataRef.current = [];
      } finally {
        setIsLoading(false);
      }
    };

    const timer = setTimeout(loadHistoricalData, 50);
    return () => clearTimeout(timer);
  }, [
    leg1Exchange, leg1Symbol, leg1Type,
    leg2Exchange, leg2Symbol, leg2Type,
    timeframe, leg1Side, leg2Side,
    calculateSpreadRatio, calculatePrecision,
    loadKlinesWithTimeRange,
    updateSpreadData,
    loadMoreHistoricalData,
    buildChartContextKey,
    startRealtimeConnecting,
    syncRightPriceScaleWidth
  ]);

  // 訂閱實時價格
  useEffect(() => {
    if (timeframe !== '1s' || !leg1Exchange || !leg2Exchange || !leg1Symbol || !leg2Symbol) {
      return;
    }

    const subscriptions = buildTickerSubscriptions();
    const subscribeMessage = {
      type: 'chartTickerSubscribe',
      data: { subscriptions },
    };
    const unsubscribeMessage = {
      type: 'chartTickerUnsubscribe',
      data: { subscriptions },
    };

    const sendSubscribe = () => {
      sendWebSocketMessage(subscribeMessage);
    };

    sendSubscribe();
    const retryTimer = window.setInterval(sendSubscribe, 3000);

    return () => {
      window.clearInterval(retryTimer);
      sendWebSocketMessage(unsubscribeMessage);
    };
  }, [timeframe, leg1Exchange, leg1Symbol, leg2Exchange, leg2Symbol, buildTickerSubscriptions]);

  useEffect(() => {
    const handleChartTickerUpdate = (event: any) => {
      if (timeframeRef.current !== '1s') return;
      const ticker = event?.detail?.data;
      if (!ticker) return;

      const exchange = String(ticker.exchange || '').toLowerCase();
      const symbol = String(ticker.symbol || '').toUpperCase();
      const category = String(ticker.category || 'spot').toLowerCase();
      const price = Number(ticker.price || 0);
      const timestamp = Number(ticker.timestamp || Date.now());

      if (price <= 0) return;

      const matchesLeg1 = exchange === leg1Exchange.toLowerCase() &&
        symbol === String(leg1Symbol || '').toUpperCase() &&
        category === leg1Type;
      const matchesLeg2 = exchange === leg2Exchange.toLowerCase() &&
        symbol === String(leg2Symbol || '').toUpperCase() &&
        category === leg2Type;

      if (matchesLeg1) {
        latestChartTickerRef.current.leg1 = { price, timestamp };
      }
      if (matchesLeg2) {
        latestChartTickerRef.current.leg2 = { price, timestamp };
      }

      const latestLeg1 = latestChartTickerRef.current.leg1;
      const latestLeg2 = latestChartTickerRef.current.leg2;
      if (!latestLeg1 || !latestLeg2) return;

      const newestTimestamp = Math.max(latestLeg1.timestamp, latestLeg2.timestamp, timestamp);
      applyLivePricePoint(latestLeg1.price, latestLeg2.price, newestTimestamp);
      stopRealtimeConnecting();
    };

    window.addEventListener('chartTickerUpdate', handleChartTickerUpdate);
    return () => {
      window.removeEventListener('chartTickerUpdate', handleChartTickerUpdate);
    };
  }, [leg1Exchange, leg1Symbol, leg1Type, leg2Exchange, leg2Symbol, leg2Type, applyLivePricePoint, stopRealtimeConnecting]);

  useEffect(() => {
    const handlePriceUpdate = (event: any) => {
      const { data: wsData } = event.detail;
      if (!wsData) return;

      // 檢查圖表實例是否仍然有效
      if (!leg1SeriesRef.current || !leg2SeriesRef.current || !spreadSeriesRef.current) {
        return;
      }

      const leg1 = wsData.leg1Price;
      const leg2 = wsData.leg2Price;

      const matchLeg1 = leg1?.exchange === leg1Exchange && leg1?.symbol === leg1Symbol;
      const matchLeg2 = leg2?.exchange === leg2Exchange && leg2?.symbol === leg2Symbol;

      if (!matchLeg1 || !matchLeg2) return;

      const rawTimestamp = wsData.timestamp || Date.now();
      const timestampMs = rawTimestamp > 1e12 ? rawTimestamp : rawTimestamp * 1000;
      const time = getBucketStartTime(timestampMs, timeframe);

      const price1 = leg1.lastPrice || leg1.bid1?.price || leg1.ask1?.price || 0;
      const price2 = leg2.lastPrice || leg2.bid1?.price || leg2.ask1?.price || 0;

      if (price1 === 0 || price2 === 0) return;

      // 實時更新不動精度

      const { percent } = calculateSpreadRatio(price1, price2);

      const leg1Point: LineData = { time, value: price1 };
      const leg2Point: LineData = { time, value: price2 };
      const spreadPoint: LineData = { time, value: percent };

      leg1DataRef.current = upsertLinePoint(leg1DataRef.current, leg1Point);
      leg2DataRef.current = upsertLinePoint(leg2DataRef.current, leg2Point);
      spreadDataRef.current = upsertLinePoint(spreadDataRef.current, spreadPoint);

      // 最大顯示 30 天的 1 分鐘 K 線數據（1440 * 30 = 43,200）
      const MAX_DATA_POINTS = 1440 * 30;
      if (leg1DataRef.current.length > MAX_DATA_POINTS) leg1DataRef.current.shift();
      if (leg2DataRef.current.length > MAX_DATA_POINTS) leg2DataRef.current.shift();
      if (spreadDataRef.current.length > MAX_DATA_POINTS) spreadDataRef.current.shift();

      try {
        if (leg1SeriesRef.current) leg1SeriesRef.current.update(leg1Point);
        if (leg2SeriesRef.current) leg2SeriesRef.current.update(leg2Point);
        if (spreadSeriesRef.current) spreadSeriesRef.current.update(spreadPoint);
      } catch (error) {
        if (error instanceof Error && error.message.includes('disposed')) {
          return;
        }
        console.debug('更新圖表數據時發生錯誤（可忽略）:', error);
      }
    };

    window.addEventListener('priceUpdate', handlePriceUpdate);
    return () => {
      window.removeEventListener('priceUpdate', handlePriceUpdate);
    };
  }, [leg1Exchange, leg1Symbol, leg2Exchange, leg2Symbol, leg1Side, leg2Side, timeframe, calculateSpreadRatio, getBucketStartTime, upsertLinePoint]);

  return (
    <Card
      styles={{
        body: {
          padding: 0,
          background: '#0b0e11',
          overflow: 'visible',
        },
      }}
      style={{
        background: '#0b0e11',
        border: '1px solid #2b3139',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      {/* Loading 遮罩層與內容包裹 */}
      <div style={{ position: 'relative' }}>
        {/* Loading 遮罩 */}
        {(isLoading || isRealtimeConnecting) && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'rgba(11, 14, 17, 0.7)',
              zIndex: 10,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              color: '#f0b90b',
            }}
          >
            <Spin />
          </div>
        )}

        {showScrollToLatest && !isLoading && !isRealtimeConnecting && (
          <Button
            aria-label="回到目前"
            title="回到目前"
            icon={<DoubleRightOutlined />}
            onClick={scrollToLatest}
            size="small"
            shape="circle"
            style={{
              position: 'absolute',
              right: RIGHT_SCALE_WIDTH + 12,
              bottom: spreadChartHeight + 16,
              zIndex: 9,
              width: 28,
              height: 28,
              minWidth: 28,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(30, 35, 41, 0.92)',
              borderColor: '#3a4149',
              color: '#d1d4dc',
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.35)',
            }}
          />
        )}

        {/* 時間周期選擇按鈕 */}
        <div
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid #2b3139',
            background: '#0b0e11',
          }}
        >
          <Space size="small">
            {timeframeOptions.map((option) => (
              <Button
                key={option.value}
                type={timeframe === option.value ? 'primary' : 'default'}
                size="small"
                onClick={() => setTimeframe(option.value)}
                style={{
                  background: timeframe === option.value ? '#f0b90b' : 'transparent',
                  borderColor: timeframe === option.value ? '#f0b90b' : '#2b3139',
                  color: timeframe === option.value ? '#0b0e11' : '#848e9c',
                  minWidth: '50px',
                }}
              >
                {option.label}
              </Button>
            ))}
          </Space>
        </div>

        {/* 上方圖表：價格走勢 */}
        <div
          ref={priceChartContainerRef}
          style={{
            position: 'relative',
            width: '100%',
            height: priceChartHeight,
            minHeight: priceChartHeight,
            overflow: 'visible',
            boxSizing: 'border-box',
          }}
          className="lightweight-charts-price-scale"
        />

        {/* 間距 */}
        <div style={{ height: '8px' }} />

        {/* 下方圖表：價差率 */}
        <div
          ref={spreadChartContainerRef}
          style={{
            position: 'relative',
            width: '100%',
            height: spreadChartHeight,
            minHeight: spreadChartHeight,
            overflow: 'visible',
            boxSizing: 'border-box',
          }}
          className="lightweight-charts-price-scale"
        />
      </div>
    </Card>
  );
};

export default TradingViewPriceChart;

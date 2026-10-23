/**
 * 响应式工具函数
 */

import { useState, useEffect } from 'react';

export const breakpoints = {
  xs: 480,
  sm: 576,
  md: 768,
  lg: 992,
  xl: 1200,
  xxl: 1600,
};

/**
 * Hook: 检测是否为移动端
 */
export const useIsMobile = () => {
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' && window.innerWidth <= breakpoints.md
  );

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth <= breakpoints.md);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return isMobile;
};

/**
 * Hook: 检测是否为平板
 */
export const useIsTablet = () => {
  const [isTablet, setIsTablet] = useState(
    typeof window !== 'undefined' && 
    window.innerWidth > breakpoints.md && 
    window.innerWidth <= breakpoints.lg
  );

  useEffect(() => {
    const handleResize = () => {
      setIsTablet(
        window.innerWidth > breakpoints.md && 
        window.innerWidth <= breakpoints.lg
      );
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return isTablet;
};

/**
 * Hook: 检测是否为小屏幕手机
 */
export const useIsSmallMobile = () => {
  const [isSmallMobile, setIsSmallMobile] = useState(
    typeof window !== 'undefined' && window.innerWidth <= breakpoints.xs
  );

  useEffect(() => {
    const handleResize = () => {
      setIsSmallMobile(window.innerWidth <= breakpoints.xs);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return isSmallMobile;
};

